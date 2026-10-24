# Connect Claude Code to Mnemonis

1. Start the server (`npm run dev`), register or sign in (in the Mnemonis web app, or `POST /api/auth/register` / `POST /api/auth/login`, see the README), then create an MCP token: use the web app's MCP Connections page, or `POST /api/tokens` with your login session (`curl -X POST http://localhost:8787/api/tokens -H "Authorization: Bearer <session ms_...>" -H "Content-Type: application/json" -d '{"label":"claude-code"}'`). The `mn_...` token in the response is shown only once. Each token belongs to your account and reaches only your memories.
2. Register the server (verified against `claude mcp add --help`):

```bash
claude mcp add --transport http mnemonis http://localhost:8787/mcp --header "Authorization: Bearer mn_..."
```

Syntax notes from `claude mcp add --help`:

- Usage is `claude mcp add [options] <name> <commandOrUrl> [args...]`; `--transport` (`-t`) is `stdio`, `sse` or `http` (default `stdio`).
- `--header` (`-H`) takes one or more values and is variadic, so put `<name>` and `<url>` **before** it, as above.
- `--scope` (`-s`) is `local` (default), `user` or `project`. Use `--scope user` to make it available in all your projects. Avoid `project` (it writes the token into a shared `.mcp.json`).
- Change the port in the URL if you set `PORT`.

3. Check it: run `claude mcp list` (it should show `mnemonis` connected) or `/mcp` inside Claude Code.

Tools appear as `mcp__mnemonis__memory_search`, `mcp__mnemonis__memory_save`, and so on.

## What to expect

- Reading works immediately (`memory_search`, `memory_read`, `memory_list`, `memory_related`, `memory_history`, `memory_status`, `memory_diff`).
- Every write (`memory_save`, `memory_update`, `memory_link`, `memory_archive`) is a **pending draft**. Open the Mnemonis web app, go to the Inbox and approve or reject it. Approve/reject is not available to Claude.
- `memory_status` shows how many drafts are waiting and what was saved recently.

## Rotating or revoking a token

Create a new token with `POST /api/tokens`, then revoke the old one with `DELETE /api/tokens/<id>` (list ids with `GET /api/tokens`); a revoked token stops working on the next request.

```bash
claude mcp remove mnemonis
claude mcp add --transport http mnemonis http://localhost:8787/mcp --header "Authorization: Bearer mn_<new token>"
```

## Troubleshooting

- `401`: unknown, revoked or expired token, or a login session (`ms_...`) used instead of an `mn_` token. Create a new token and re-add.
- `503`: the database is unavailable.
- `403 Host/Origin`: only `localhost`, `127.0.0.1` or `[::1]` with the server port are accepted as Host, plus anything in `MNEMONIS_ALLOWED_HOSTS`.
- Port in use: set `PORT` and use the same port in the URL.
