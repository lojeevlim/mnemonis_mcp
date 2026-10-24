# Mnemonis MCP server

A multi-user server that owns each user's Mnemonis workspace (PostgreSQL, one workspace per user) and exposes it two ways:

- **REST** (`/api/*`) for the Mnemonis web app (the human, who approves changes), authenticated with a Supabase (or other OIDC) **JWT**, and
- **MCP over Streamable HTTP** (`/mcp`) for agents such as Claude Code, authenticated with an **`mn_` MCP token** the user creates. Agents can read memory and *propose* changes; every agent write lands in the Inbox as a **pending draft** that only the user can approve in the web app.

HTTP only (no stdio). `GET /api/health` is the only unauthenticated endpoint. (Full documentation rewrite pending; this section is the minimal current description.)

## Setup and run

```bash
npm install
npm run db:up && npm run db:migrate   # PostgreSQL via docker compose, then apply migrations (or set MNEMONIS_AUTO_MIGRATE=1)
npm run dev                           # tsx watch, or:  npm run build && npm start
```

Copy `.env.example` to `.env` and load it into the shell (`set -a; . ./.env; set +a`). To create an MCP token, sign in to the web app, then call `POST /api/tokens` with the JWT (the server prints the exact `curl` and `claude mcp add` commands on start; see [docs/claude-code-setup.md](docs/claude-code-setup.md)).

```bash
npm run dev:jwt -- --email you@example.test   # local dev identity provider + a signed 1h JWT (see "Local development auth")
npm run smoke              # throw-away multi-user server (TEST_DATABASE_URL): health, JWT REST, mcp token, MCP tools
npm run sync-domain        # re-vendor src/domain from the web repo (../mnemonis)
npm run typecheck && npm run lint && npm test && npm run build
```

### Local development auth

`SUPABASE_URL` takes precedence over `AUTH_*`, so a `.env` that sets it must be unset to use the local issuer:

```bash
npm run dev:jwt -- --email you@example.test --name "You"   # keep running; prints a JWT on stdout (valid 1 hour)
# in another shell:
set -a; . ./.env; set +a; unset SUPABASE_URL
AUTH_ISSUER=http://127.0.0.1:9999 AUTH_JWKS_URL=http://127.0.0.1:9999/.well-known/jwks.json AUTH_AUDIENCE=authenticated \
MNEMONIS_SIGNUP_MODE=open npm run dev
curl -H "Authorization: Bearer <jwt>" http://localhost:8787/api/me
```

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | required | PostgreSQL connection string |
| `SUPABASE_URL` | none | Derives issuer (`<origin>/auth/v1`), JWKS URL and audience `authenticated`; takes precedence over `AUTH_*` |
| `AUTH_ISSUER`, `AUTH_JWKS_URL`, `AUTH_AUDIENCE` | required without `SUPABASE_URL` | Non-Supabase / local issuer settings |
| `AUTH_ALGS` | `ES256,RS256,EdDSA` | Accepted JWT algorithms (HS* and none are refused) |
| `MNEMONIS_SIGNUP_MODE` | `closed` | `closed` (existing users only), `allowlist` or `open` (both need a verified email) |
| `MNEMONIS_ALLOWED_EMAILS` | none | Allowlist entries: `a@b.com` or `@domain.com` |
| `MNEMONIS_MAX_MCP_TOKENS` | `20` | Active MCP tokens per user |
| `MNEMONIS_AUTO_MIGRATE` | `false` | Run migrations on start (otherwise run `npm run db:migrate`) |
| `PORT` | `8787` | Listen port |
| `HOST` | `127.0.0.1` | Bind address |
| `MNEMONIS_ALLOWED_ORIGINS` | `http://localhost:5173` | Comma-separated browser origins allowed by CORS (exact match, never `*`) |
| `MNEMONIS_ALLOWED_HOSTS` | none | Extra exact `Host` header values accepted besides loopback with the port |
| `MNEMONIS_TRUST_PROXY` | `false` | Only the failed-auth limiter reads `X-Forwarded-For` (its LAST entry, appended by your proxy). Enable only behind a trusted proxy that is the sole way to reach the app; otherwise clients can spoof it |

The human actor name on REST writes is the signed-in user's display name (`MNEMONIS_USER_NAME` and `MNEMONIS_DATA_DIR` are no longer used by the server).

## REST API

All requests except `/api/health` need `Authorization: Bearer <JWT>` (an `mn_` MCP token is refused on `/api/*`, and a JWT is refused on `/mcp`; every refusal is the same `401`). Every `/api` response is `Cache-Control: no-store`.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | exactly `{ok: true}`; no auth, no data |
| `GET /api/me` | `{id, email, displayName}` |
| `POST /api/tokens` | `{label, expiresInDays?}` creates an MCP token; `201 {id, token, prefix, label, createdAt, expiresAt}`; the token is shown once. 409 at the per-user cap |
| `GET /api/tokens` | The user's MCP tokens (no secrets) |
| `DELETE /api/tokens/:id` | Revoke (204; 404 for unknown or someone else's) |
| `GET /api/state` | `{rev, state}`; `ETag: "<rev>"`; honours `If-None-Match` (304) |
| `PUT /api/state` | Import/replace from exported JSON. Requires `If-Match: "<rev>"` (428 if missing, 409 if stale). Up to 10 MB |
| `GET /api/export` | Pretty JSON export |
| `POST /api/ops/:name` | One mutation; the JSON body is the argument object; returns `{rev, state, value}` |

Ops (same names and arguments as the web `MemoryRepository`, plus an optional agent `actor` on write ops, see below): `createMemory`, `updateMemory`, `archiveMemory`, `restoreMemory`, `rollbackMemory`, `addRelation`, `removeRelation`, `createCollection`, `updateCollection`, `deleteCollection`, `approve`, `reject`, `approveRelation`, `rejectRelation`, `approveAll`, `rejectAll`, `approveAllDetailed`, `rejectAllDetailed`. Anything else is 404. Bodies are validated with strict schemas (unknown keys: 400) and limited to 1 MB (413).

The actor is the server-side human user, with one **downgrade-only** exception. For the memory/relation write ops (`createMemory`, `updateMemory`, `archiveMemory`, `restoreMemory`, `rollbackMemory`, `addRelation`) the body may carry `"actor": {"kind": "agent", "name": "<1..100 chars, no control characters>"}` (validated with the domain's `assertActor`); the write then runs as that agent and lands **pending** in the Inbox (used by the web app's rule-based Memory Health checks). Any other `actor` (kind `user`, missing, malformed) is silently ignored and the server user is used: a body can never upgrade or impersonate the user. Review ops (`approve`, `reject`, `approveRelation`, `rejectRelation`, `approveAll`, `rejectAll`, the `Detailed` variants) and `removeRelation` always run as the server user; an `actor` in their body is ignored (not rejected). Collection ops ignore it too. The audit log records the effective `actorKind` and name.

Errors: `{error: {code, message}}` with 400 `invalid_input`, 404 `*_not_found`, 403 `forbidden`, 409 (`not_pending`, `proposal_outdated`, `duplicate_*`, `collection_not_empty`, `endpoint_not_saved`, `not_saved`, `memory_archived`, `conflict`), 422 `too_large`, 429 `rate_limited`/`inbox_full`, 500 `internal` (never a stack trace or file path).

## Operator CLI

`npm run cli -- <command>` talks to a running server's REST API with your Supabase session. It reads only `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `MNEMONIS_API_URL` (from the environment, falling back to `.env`); nothing else in `.env` (such as `DATABASE_URL`) is loaded. `SUPABASE_ANON_KEY` must be the public key: only `sb_publishable_*` or an `anon`-role JWT is accepted, everything else (service-role, secret, malformed) is refused. `SUPABASE_URL` and `MNEMONIS_API_URL` (default `http://127.0.0.1:8787`) must be `https`, or `http` for localhost / 127.0.0.0/8 / `::1`, with no credentials, query or fragment; they are checked before any prompt or request. Requests refuse redirects and time out after 15 s.

The stored session is bound to the `SUPABASE_URL` and `MNEMONIS_API_URL` it was issued for; if either changes, run `login` again. The session directory must be a real directory you own, and the file is refused unless it is a regular file owned by you with mode `0600`.

| Command | Does |
| --- | --- |
| `login [--email <e>]` | Password is read from a hidden prompt (never from arguments). Tokens (not the password) are stored in `~/.mnemonis/cli-session.json` (dir `0700`, file `0600`) and refreshed automatically |
| `logout` | Best-effort sign-out at Supabase (`/auth/v1/logout`, scope local), then deletes the file; it says whether the session was revoked remotely or only deleted locally |
| `me` | Show id, email, display name |
| `tokens list` / `tokens create <label> [--days N]` / `tokens revoke <id>` | Manage MCP tokens (`--days` 1-365). `create` prints the `mn_` token exactly once, inside the `claude mcp add` line. That token is long-lived and, once pasted, lands in your shell history and process arguments, so clear it from history and revoke it if it leaks |
| `inbox` | List every pending revision (any origin, tagged) and relation: exactly the set `approve-all` would approve |
| `approve <revisionId>` / `reject <revisionId>` / `approve-relation <id>` / `reject-relation <id>` / `approve-all [--yes]` | Review proposals. `approve-all` shows the pending count (including items not proposed by an agent) and needs `--yes` or a `y` at an interactive prompt; without a TTY it fails unless `--yes` is given |
| `health` | Check the server |

## MCP tools (`POST /mcp`)

Read: `memory_search`, `memory_read`, `memory_list`, `memory_related`, `memory_history`, `memory_status`, `memory_diff`.
Write (always pending): `memory_save`, `memory_update`, `memory_link`, `memory_archive`.

There are no approve, reject, delete, commit or branch tools. Tools never accept an actor, origin or provenance. The MCP endpoint is stateless (a fresh server per request), so `GET`/`DELETE /mcp` return 405.

Reads return saved memory only. A memory that has never been approved is not listed or searchable, and `memory_read` shows only proposal metadata for it. Results are JSON that starts with a `notice` reminding the model that memory content is untrusted data.

## Hosting on Supabase

- Set `DATABASE_URL` (operator-side, never committed) to the Supabase **pooler** connection string for the database owner role, then run `npm run db:migrate`.
- Migration `0002_enable_rls.sql` turns on Row-Level Security with no policies for every table (`users`, `workspaces`, `api_tokens`, `audit_log`, `schema_migrations`), so the public anon key cannot read or write them through the Data API. The server connects as the table owner, which bypasses RLS (`FORCE` is deliberately not used; it would lock the owner out).
- Never put the Supabase service-role key in this server; it only needs `SUPABASE_URL` (public JWKS) and the database URL.
- If the database password was ever shared or pasted anywhere, rotate it and update `DATABASE_URL`.

## Security model

- **Host check**: the `Host` header must be `localhost`, `127.0.0.1` or `[::1]` with the server's port, or an exact (case-insensitive) match of `MNEMONIS_ALLOWED_HOSTS` (DNS-rebinding defence), on every route including `/mcp`.
- **Origin check**: requests carrying an `Origin` header (browsers) must match `MNEMONIS_ALLOWED_ORIGINS` exactly, otherwise 403. CORS preflights answer 204 only for allowed origins; allowed methods are `GET, POST, PUT, DELETE, OPTIONS`.
- **Credentials**: the credential type picks the verifier (JWT for `/api/*`, `mn_` token for `/mcp`); tokens are stored as SHA-256 hashes, shown once, and revocation takes effect on the next request. Database failures during authentication give `503`, not `401`. Repeated failed authentication from one client gets `429`.
- **Per-user isolation**: every handler gets its user id only from the authenticated context; each user has a separate workspace, inbox cap and write rate limit (60 writes per minute per user, across all of that user's tokens).
- **Agents cannot commit memory**: MCP writes go through a guard that forces an agent actor, so every write is a pending proposal. Limits: title 200 chars, content 50 000, 20 tags of 50 chars, metadata 8 KB, search query 500 chars, list limit 100, at most 200 unreviewed agent items in the Inbox, 60 writes per minute per user.
- **Prompt injection**: memory content is data. Tool descriptions and results say so, but a model can still be misled by hostile text, so the user stays the approval gate.
- **Audit**: the `audit_log` table records user, door, action and ids, never content or tokens (best-effort, bounded queue).

## Layout

```
src/domain/    vendored pure domain code from the web repo (do not edit; npm run sync-domain)
src/store/     pgStore (multi-user Postgres); fileStore/importJson are legacy and pending removal
src/service/   memoryService + guards (the only things REST and MCP call)
src/auth/      jwt, users (provisioning), apiTokens, accounts; token.ts + cli.ts are legacy and pending removal
src/http/      Hono app: server, auth middleware, rest, cors/host/origin guards
src/mcp/       MCP server + the 11 tools
src/audit.ts   Postgres audit trail
```
