# Connect Claude Code to Mnemonis

Mnemonis is three projects. Claude Code talks to the **MCP adapter** (this project, port **8788**); the adapter forwards your token to the **Mnemonis API** (`mnemonis_api`, port **8787**), which owns the accounts, the database and every rule. Tokens are created in the **web app** (`mnemonis`, port 5173), never in this project.

1. Start the three projects (see the README: API, then this adapter, then the web app), register or sign in in the web app, open **MCP Connections** and create a token. The `mn_...` token is shown only once. Each token belongs to your account and reaches only your memories. (Without the web app: `POST /api/auth/register` or `/api/auth/login` on the API, then `POST /api/tokens` with the `ms_` session you get back, see the `mnemonis_api` README.)
2. Register the adapter (verified against `claude mcp add --help`):

```bash
claude mcp add --transport http mnemonis http://localhost:8788/mcp --header "Authorization: Bearer mn_..."
```

Syntax notes from `claude mcp add --help`:

- Usage is `claude mcp add [options] <name> <commandOrUrl> [args...]`; `--transport` (`-t`) is `stdio`, `sse` or `http` (default `stdio`).
- `--header` (`-H`) takes one or more values and is variadic, so put `<name>` and `<url>` **before** it, as above.
- `--scope` (`-s`) is `local` (default), `user` or `project`. Use `--scope user` to make it available in all your projects. Avoid `project` (it writes the token into a shared `.mcp.json`).
- Change the port in the URL if you set `MCP_PORT`. The URL is exactly what the web app shows on its MCP Connections page (the API publishes it as `mcpUrl`, from `MNEMONIS_MCP_URL`).

3. Check it: run `claude mcp list` (it should show `mnemonis` connected) or `/mcp` inside Claude Code.

Tools appear as `mcp__mnemonis__memory_search`, `mcp__mnemonis__memory_save`, and so on.

## What to expect

- Reading works immediately (`memory_search`, `memory_read`, `memory_list`, `memory_related`, `memory_history`, `memory_status`, `memory_diff`).
- Every write (`memory_save`, `memory_update`, `memory_link`, `memory_archive`) is a **pending draft**. Open the Mnemonis web app, go to the Inbox and approve or reject it. Approve/reject is not available to Claude.
- `memory_status` shows how many drafts are waiting and what was saved recently.
- The adapter tells Claude to use memory proactively: search for the project name at the start of work, and after exploring a project, propose a save without being asked (no need to say "mnemonis"). Entries are formatted `<project name>: <data>` and tagged with the project name. The server automatically proposes a "part of" link from `<project name>: <data>` to the memory titled exactly `<project name>` (the project hub); the link is created for you and appears once the memories are approved (it may sit pending in the Inbox until then), and Claude should not add it with `memory_link`. If a search shows no memory titled exactly `<project name>`, Claude may propose one once per project (the web app also shows a virtual project hub until it exists). This is guidance, so Claude may occasionally skip a save. Claude should also add specific lowercase topic tags (such as `stripe` or `cognito`) besides the project tag: memories in different projects sharing a topic tag are automatically linked `shares topic: <tag>` (created for you, shown after approval, not added with `memory_link`). For more reliability, add the same rule to your `CLAUDE.md`.

## Rotating or revoking a token

Create a new token in the web app, then revoke the old one there (or with `DELETE /api/tokens/<id>` on the API); a revoked token stops working on the next request, for every MCP method.

```bash
claude mcp remove mnemonis
claude mcp add --transport http mnemonis http://localhost:8788/mcp --header "Authorization: Bearer mn_<new token>"
```

## Troubleshooting

- `401` on connect: unknown, revoked or expired token, or a login session (`ms_...`) used instead of an `mn_` token. Create a new token and re-add.
- `429`: too many failed attempts from your address; wait for `Retry-After` seconds.
- `503` `contract_mismatch`: the adapter and the API speak different agent-API contracts; update the older of the two.
- `503` `upstream_unavailable` (or `/healthz` is 503): the adapter cannot reach the API at `MNEMONIS_API_URL`, or the API's database is down.
- Tool error `Mnemonis server configuration problem`: the API refused the adapter itself (wrong Host: add the adapter's `host:port` to the API's `MNEMONIS_ALLOWED_HOSTS`). The adapter's log has the request id.
- `403` `forbidden_host` from the adapter: only `localhost`, `127.0.0.1` or `[::1]` with the adapter's port are accepted as Host, plus anything in `MNEMONIS_ALLOWED_HOSTS` (adapter setting).
- Port in use: set `MCP_PORT` and use the same port in the URL.
