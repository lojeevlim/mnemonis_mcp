# Connect Claude Code to Mnemonis

1. Start the server: `npm run dev` (or `npm run build && npm start`). On the first run it prints a token and the command below. Later: `npm run token`.
2. Register the server (verified against `claude mcp add --help`):

```bash
claude mcp add --transport http mnemonis http://localhost:8787/mcp --header "Authorization: Bearer <token>"
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

## Rotating the token

```bash
npm run token -- --rotate        # old token stops working immediately
claude mcp remove mnemonis
claude mcp add --transport http mnemonis http://localhost:8787/mcp --header "Authorization: Bearer <new token>"
```

## Troubleshooting

- `401`: wrong or rotated token. Re-run `npm run token` and re-add.
- `403 Host/Origin`: only `localhost`, `127.0.0.1` or `[::1]` with the server port are accepted as Host. A hostname or a tunnel will not work by design.
- `Cannot start: Workspace is locked`: another Mnemonis server uses the same data dir.
- Port in use: set `PORT` and use the same port in the URL.
