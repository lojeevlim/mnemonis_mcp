# Mnemonis MCP adapter

A thin, stateless **MCP (Streamable HTTP) adapter** for Mnemonis. It speaks MCP to Claude Code (and any other MCP client) on `POST /mcp` and turns every tool call into one HTTP request to the Mnemonis API's internal `/api/agent/*` surface. It has **no database, no domain logic, no secrets and no decisions about who may do what**: the caller's `Authorization: Bearer mn_...` header is forwarded verbatim and the API accepts or refuses it.

It is one of **three separate projects**:

| Project | What it is | Port | Talks to |
| --- | --- | --- | --- |
| `mnemonis` (web app) | React UI: sign in, review the Inbox (approve/reject agent drafts), create MCP tokens | 5173 (Vite dev) | the API only, with an `ms_` session |
| `mnemonis_api` | accounts, sessions, MCP tokens, PostgreSQL, domain rules, REST `/api/*`, internal `/api/agent/*`, audit | **8787** | PostgreSQL |
| **`mnemonis_mcp` (this repo)** | the MCP adapter: 11 tools, schemas, descriptions, error mapping | **8788** | the API's `/api/agent/*` |

```
Browser -- mnemonis (:5173) --ms_ session--> mnemonis_api (:8787) --> PostgreSQL
Claude Code / MCP client --POST /mcp, Bearer mn_--> mnemonis_mcp (:8788) --HTTP, mn_ forwarded--> /api/agent/* (mn_ only)
```

Tokens are created in the **web app** (against the API); Claude Code's `claude mcp add` URL points at **this adapter**.

## Run all three locally

```bash
# 1. API + database (../mnemonis_api)
cd ../mnemonis_api
cp .env.example .env && set -a && . ./.env && set +a    # set POSTGRES_PASSWORD (and in DATABASE_URL)
npm install && npm run db:up && npm run db:migrate
npm run dev                                              # http://127.0.0.1:8787

# 2. This adapter
cd ../mnemonis_mcp
npm install
npm run dev                                              # http://127.0.0.1:8788/mcp, forwards to MNEMONIS_API_URL (default http://127.0.0.1:8787)

# 3. Web app (../mnemonis)
cd ../mnemonis && npm install && npm run dev             # http://localhost:5173 (VITE_API_URL defaults to http://localhost:8787)
```

Or run the API, the database and this adapter with docker compose from the API project: `cd ../mnemonis_api && docker compose --profile full up -d --build`.

Then in the web app register, open **MCP Connections**, create a token (shown once) and run:

```bash
claude mcp add --transport http mnemonis http://localhost:8788/mcp --header "Authorization: Bearer mn_..."
```

See [docs/claude-code-setup.md](docs/claude-code-setup.md) and the optional [subagent](docs/mnemonis-subagent.md). For the API's `/api/auth/config` to show the right URL, its `MNEMONIS_MCP_URL` (the design doc calls it `MNEMONIS_PUBLIC_MCP_URL`; the API accepts both, `MNEMONIS_MCP_URL` wins) must be the URL clients use to reach this adapter (default `http://localhost:8788/mcp`). If the adapter reaches the API under a name other than loopback (for example `api:8787`), the API's `MNEMONIS_ALLOWED_HOSTS` must include that `host:port`.

## Environment variables

No `DATABASE_URL`, no keys. Copy `.env.example` to `.env` (loaded by `npm run dev` / `npm start`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `MNEMONIS_API_URL` | `http://127.0.0.1:8787` | The API to forward to. `https`, or `http` on loopback; no credentials, query or fragment. Fixed configuration, never taken from a request |
| `MNEMONIS_API_ALLOW_INSECURE_PRIVATE` | `false` | Also allow `http` to a private-network address or a single-label name such as `http://api:8787` (docker compose). A public name over `http` is never allowed |
| `MCP_HOST` | `127.0.0.1` | Bind address |
| `MCP_PORT` | `8788` | Listen port (`0` = ephemeral) |
| `MNEMONIS_ALLOWED_HOSTS` | none | Extra exact `Host` values accepted besides loopback with the port (DNS-rebinding defence) |
| `MNEMONIS_ALLOWED_ORIGINS` | none | MCP clients send no `Origin`; any `Origin` not listed is refused with 403. CORS headers are never sent |
| `MNEMONIS_TRUST_PROXY` | `false` | With a non-loopback `MCP_HOST` and this unset the adapter prints the same loud startup warning as the API (behind a proxy every client shares one limiter bucket; it does not fail). Use the LAST `X-Forwarded-For` entry (a valid IP) as the client address (failed-auth limiter, forwarded to the API). Only behind a trusted proxy that is the sole way in |
| `MNEMONIS_ADAPTER_SECRET` | none | Optional shared secret with the API (same value as the API's `MNEMONIS_ADAPTER_SECRET`; 16-256 printable ASCII characters, no spaces). Sent to the API as `X-Mnemonis-Adapter-Secret` on every call; when it matches, the API honours the `X-Forwarded-For` the adapter sends (the real MCP client's IP) on `/api/agent/*` only, so each client gets its own failed-auth bucket there instead of all clients sharing the adapter's address. Without it the API sees the adapter's address for everyone (one client's bad tokens can then lock out all others). Never logged. Keep the adapter-to-API hop private |
| `MNEMONIS_UPSTREAM_READ_TIMEOUT_MS` | `10000` | Timeout of a read call to the API (connect timeout is fixed at 2 s) |
| `MNEMONIS_UPSTREAM_WRITE_TIMEOUT_MS` | `20000` | Timeout of a write call (never retried) |
| `MNEMONIS_MAX_BODY_BYTES` | `1048576` | Cap on a `/mcp` request body (413) |

`PORT` and `HOST` are deliberately **not** read (they belong to the API); the adapter uses `MCP_PORT` / `MCP_HOST`.

## Tools

Read: `memory_search`, `memory_read`, `memory_list`, `memory_related`, `memory_history`, `memory_status`, `memory_diff`. Write (always a pending draft the user approves in the web app's Inbox): `memory_save`, `memory_update`, `memory_link`, `memory_archive`. There are no approve, reject, delete, commit or branch tools, and no tool accepts an actor, origin, source or provenance (schemas are strict). Results are JSON starting with a `notice` that memory content is untrusted data. Tool names, descriptions, annotations and zod schemas live here ([src/mcp](src/mcp)); the schemas are duplicated from the API on purpose and checked against `contract/agent-v1/limits.json`.

The server automatically proposes a "part of" link from a memory titled `<project>: <data>` to the memory titled exactly `<project>` (case-insensitive). The link is created for you and appears once the memories are approved (it may sit pending in the Inbox until then); do not add it with `memory_link`, which is only for other relations. If a search shows no memory titled exactly `<project>`, the agent may propose one (the project hub) once per project. The web Knowledge Graph shows a view-only project circle for any project that has a memory titled `<project>: <data>`, even before a memory titled `<project>` exists; creating the hub memory stores the real links.

Tag memories with specific lowercase topic tags (technology or subject, such as `stripe` or `cognito`) in addition to the project tag. When memories titled `<project>: <data>` in different projects share a topic tag, the server automatically proposes a `shares topic: <tag>` link between them (at most 3 per other project per topic, 12 per save; project tags are never topics, and memories without a `<project>: ` title prefix do not take part). Like the "part of" link it is created for you and appears once the memories are approved (it may sit pending in the Inbox until then); do not add it with `memory_link`.

`GET`/`DELETE`/`PUT /mcp` are `405` (`Allow: POST`); the adapter is stateless (a fresh MCP server per request). `GET /healthz` is `200` once the API's contract is confirmed and `503` before that (or on a mismatch).

## How a request flows

0. `/mcp` takes ONE JSON-RPC message per HTTP request: a batch array is refused with `400` / `-32600` "batch requests are not supported" (before any upstream call), so a single request can never multiply upstream calls or failures. At most one failure is counted per HTTP request, and a tool call stops at the first upstream `401`.
1. Host and Origin checks, then the adapter's own failed-authentication limiter (per client address).
2. The `Authorization` header must be a plausible `Bearer` value; validity is the API's decision.
3. **Preflight**: every request that does not itself carry a valid tool call to the API (`initialize`, `tools/list`, notifications, invalid or unknown tool calls) first calls `GET /api/agent/ping` with the caller's header. Upstream `401` becomes HTTP `401` + `WWW-Authenticate: Bearer realm="mnemonis"` (a revoked token stops working on the very next request, with no cache); upstream `429 too_many_failed_attempts` is HTTP `429` + `Retry-After`; any other preflight failure is HTTP `503`. A forwarded `tools/call` uses its own upstream call as the check.
4. Each tool call is one `POST /api/agent/memory/<tool>`. Forwarded headers are only `Authorization` (verbatim), `Content-Type`, `X-Mnemonis-Contract`, `X-Mnemonis-Client` (the MCP `clientInfo.name`, remembered per token hash, sanitised printable ASCII), `X-Request-Id` and `X-Forwarded-For` (a single resolved client IP) and, only when `MNEMONIS_ADAPTER_SECRET` is set, `X-Mnemonis-Adapter-Secret`. Everything else a client sent is dropped.
5. Results: `200` becomes the tool's data behind the `notice`; `400/404/409/413/422` and `429 rate_limited|inbox_full` become tool errors (`isError`) with the API's code and a message clipped to 500 characters; `401` is HTTP 401; `403/426`/malformed responses become the tool error `internal` "Mnemonis server configuration problem" (logged with the request id); `5xx`/connect errors are `upstream_unavailable`; a write timeout is `upstream_timeout` ("may or may not have been recorded; call memory_status before retrying"). Reads and the preflight are retried once on connect errors / 502 / 503 / 504; writes are never retried. Redirects are an error and are never followed; upstream responses are capped at 5 MiB.
6. Tokens, request bodies and API messages are never logged.

## Contract with the API

The API's internal surface is versioned (`GET /api/agent/contract`) and pinned by fixtures in the API repo (`contract/agent-v1`). This adapter vendors them (`npm run sync-contract`, which writes `contract/agent-v1/SOURCE.txt` with the source commit and a content hash), replays them against a fake API in `npm test`, and checks at startup that the API's contract version and tool set are compatible (backing off while the API is unreachable; `/healthz` and `/mcp` answer `503` on a mismatch). CI runs `npm run check-contract` against a checkout of `mnemonis_api`.

```bash
npm run sync-contract                 # copy ../mnemonis_api/contract/agent-v1 here (or: -- --api <path>)
npm run check-contract                # exit 1 when the vendored copy is out of date
```

## Develop and test

```bash
npm run typecheck && npm run lint && npm test && npm run build
E2E=1 E2E_API_URL=http://127.0.0.1:8787 npm run e2e   # opt-in: MCP SDK client -> this adapter -> a REAL API (throw-away local DB; registration must be open)
```

`npm test` needs no database: a fake API (a small HTTP server) replays the contract fixtures and checks the outbound request shape, the header allow-list, the preflight rules, the `401`/`429` mapping, retry and timeout behaviour, redirects, the response cap and that tokens never reach the log. A test also asserts the adapter source imports nothing from a database, `jose` or a domain.

## Layout

```
src/index.ts          entry point (listens on MCP_HOST:MCP_PORT)
src/config.ts         environment parsing (MNEMONIS_API_URL, MCP_PORT, ...)
src/http/guards.ts    Host/Origin guards, bearer shape check, failure limiter, client address
src/mcp/              server.ts (the /mcp handler), tools.ts (names, descriptions, annotations), schemas.ts (zod)
src/upstream/         client.ts (HTTP to the API: timeouts, retry, redirect error, size cap), errors.ts (result mapping)
src/clientNames.ts    bounded clientInfo.name cache keyed by sha256(token)
src/contract.ts       contract handshake with the API
contract/agent-v1/    vendored fixtures (scripts/sync-contract.mjs)
test/                 unit + fake-API tests; test/e2e is opt-in
```
