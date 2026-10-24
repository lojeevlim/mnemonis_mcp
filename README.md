# Mnemonis MCP server

A local server that owns the Mnemonis workspace (one JSON file on disk) and exposes it two ways:

- **REST** (`/api/*`) for the Mnemonis web app (the human, who approves changes), and
- **MCP over Streamable HTTP** (`/mcp`) for agents such as Claude Code. Agents can read memory and *propose* changes; every agent write lands in the Inbox as a **pending draft** that only the user can approve in the web app.

HTTP only (no stdio). One bearer token protects everything except `GET /api/health`.

## Setup and run

```bash
npm install
npm run dev          # tsx watch, or:  npm run build && npm start
```

On the first run the server creates `~/.mnemonis/`, generates a token, and prints it once together with the exact registration command for Claude Code (see [docs/claude-code-setup.md](docs/claude-code-setup.md)).

```bash
npm run token              # print the token again (plus the claude mcp add command)
npm run token -- --rotate  # new token; the old one stops working immediately (no restart needed)
npm run smoke              # throw-away server on a random port: health + one REST op + one MCP call
npm run sync-domain        # re-vendor src/domain from the web repo (../mnemonis)
npm run typecheck && npm run lint && npm test && npm run build
```

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `MNEMONIS_DATA_DIR` | `~/.mnemonis` | Data directory (never inside a repo) |
| `PORT` | `8787` | Listen port |
| `HOST` | `127.0.0.1` | Bind address. Keep it on loopback. |
| `MNEMONIS_ALLOWED_ORIGINS` | `http://localhost:5173` | Comma-separated browser origins allowed by CORS (exact match, never `*`) |
| `MNEMONIS_USER_NAME` | `local-user` | Name stamped on writes made through REST (the human) |

## Data directory layout

```
~/.mnemonis/            (mode 0700)
  workspace.json        {schemaVersion, state, rev}: the whole workspace, written atomically
  workspace.json.bak    previous good version
  workspace.lock        PID of the running server (a second server refuses to start)
  workspace.corrupt-<timestamp>.json   quarantined copy if workspace.json cannot be read; the server then refuses to start
  token                 bearer token (mode 0600)
  audit.log             append-only JSONL: time, via (rest|mcp), client, action, ids, ok, code
```

The server never silently reseeds or overwrites an unreadable workspace. A first run starts with an empty workspace (no demo data).

## REST API

All requests except `/api/health` need `Authorization: Bearer <token>`.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | `{ok, schemaVersion, rev}`; no auth, no data |
| `GET /api/state` | `{rev, state}`; `ETag: "<rev>"`; honours `If-None-Match` (304) |
| `PUT /api/state` | Import/replace from exported JSON. Requires `If-Match: "<rev>"` (428 if missing, 409 if stale). Up to 10 MB |
| `GET /api/export` | Pretty JSON export |
| `POST /api/ops/:name` | One mutation; the JSON body is the argument object; returns `{rev, state, value}` |

Ops (same names and arguments as the web `MemoryRepository`, plus an optional agent `actor` on write ops, see below): `createMemory`, `updateMemory`, `archiveMemory`, `restoreMemory`, `rollbackMemory`, `addRelation`, `removeRelation`, `createCollection`, `updateCollection`, `deleteCollection`, `approve`, `reject`, `approveRelation`, `rejectRelation`, `approveAll`, `rejectAll`, `approveAllDetailed`, `rejectAllDetailed`. Anything else is 404. Bodies are validated with strict schemas (unknown keys: 400) and limited to 1 MB (413).

The actor is the server-side human user, with one **downgrade-only** exception. For the memory/relation write ops (`createMemory`, `updateMemory`, `archiveMemory`, `restoreMemory`, `rollbackMemory`, `addRelation`) the body may carry `"actor": {"kind": "agent", "name": "<1..100 chars, no control characters>"}` (validated with the domain's `assertActor`); the write then runs as that agent and lands **pending** in the Inbox (used by the web app's rule-based Memory Health checks). Any other `actor` (kind `user`, missing, malformed) is silently ignored and the server user is used: a body can never upgrade or impersonate the user. Review ops (`approve`, `reject`, `approveRelation`, `rejectRelation`, `approveAll`, `rejectAll`, the `Detailed` variants) and `removeRelation` always run as the server user; an `actor` in their body is ignored (not rejected). Collection ops ignore it too. The audit log records the effective `actorKind` and name.

Errors: `{error: {code, message}}` with 400 `invalid_input`, 404 `*_not_found`, 403 `forbidden`, 409 (`not_pending`, `proposal_outdated`, `duplicate_*`, `collection_not_empty`, `endpoint_not_saved`, `not_saved`, `memory_archived`, `conflict`), 422 `too_large`, 429 `rate_limited`/`inbox_full`, 500 `internal` (never a stack trace or file path).

## MCP tools (`POST /mcp`)

Read: `memory_search`, `memory_read`, `memory_list`, `memory_related`, `memory_history`, `memory_status`, `memory_diff`.
Write (always pending): `memory_save`, `memory_update`, `memory_link`, `memory_archive`.

There are no approve, reject, delete, commit or branch tools. Tools never accept an actor, origin or provenance. The MCP endpoint is stateless (a fresh server per request), so `GET`/`DELETE /mcp` return 405.

Reads return saved memory only. A memory that has never been approved is not listed or searchable, and `memory_read` shows only proposal metadata for it. Results are JSON that starts with a `notice` reminding the model that memory content is untrusted data.

## Security model

- **Local only**: binds to `127.0.0.1`. The `Host` header must be `localhost`, `127.0.0.1` or `[::1]` with the server's port (DNS-rebinding defence), on every route including `/mcp`.
- **Origin check**: requests carrying an `Origin` header (browsers) must match `MNEMONIS_ALLOWED_ORIGINS` exactly, otherwise 403. Requests without `Origin` (Claude Code, curl) are allowed if authenticated. CORS preflights answer 204 only for allowed origins; allowed headers are `Authorization, Content-Type, If-Match`.
- **One bearer token**, compared in constant time, stored 0600. The token is never logged and never appears in responses or the audit log. Anyone holding it can use the REST API as the human (including approving), so treat it like a password (a body `actor` can only make a write more restricted, i.e. pending, never less) and only give Claude Code the MCP URL plus token you trust it with.
- **Agents cannot commit memory**: MCP writes go through a guard that forces an agent actor, so every write is a pending proposal. Limits: title 200 chars, content 50 000, 20 tags of 50 chars, metadata 8 KB, search query 500 chars, list limit 100, at most 200 unreviewed agent items in the Inbox, 60 writes per minute per token.
- **Prompt injection**: memory content is data. Tool descriptions and results say so, but a model can still be misled by hostile text, so the user stays the approval gate.
- **Audit**: `audit.log` records who did what to which ids, never content.

## Layout

```
src/domain/    vendored pure domain code from the web repo (do not edit; npm run sync-domain)
src/store/     fileStore: atomic writes, lock, queue, backup, corrupt quarantine
src/service/   memoryService + guards (the only things REST and MCP call)
src/auth/      token + CLI
src/http/      Hono app: server, rest, cors/host/origin guards
src/mcp/       MCP server + the 11 tools
src/audit.ts   JSONL audit log
```
