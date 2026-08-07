# actual-mcp-server

MCP server for [Actual Budget](https://actualbudget.org/), built for Claude, Cursor, and other AI agents.

Actual has no REST API. Its official [`@actual-app/api`](https://actualbudget.org/docs/api/) package is the app's own engine running headless: it downloads the whole budget into a local SQLite file, runs every method against that copy, and syncs CRDT messages back to the server. That architecture is why generic per-request wrappers fight it — and why this server is built around a **long-lived engine singleton** instead:

- **Init once, never per call.** The budget downloads at startup; tool calls are then local reads/writes with no init/teardown races.
- **Serialized writes.** All mutations run through a mutex, so bulk operations can't corrupt or lock the budget file.
- **Graceful shutdown.** SIGINT/SIGTERM/stdin-close flush pending sync and release the SQLite file.
- **Cache-reset recovery.** `actual_reload_budget` deletes the stale local cache and re-downloads — no more restarting the MCP server by hand after resetting the budget cache in the Actual UI.
- **Full budget-envelope surface.** Set budgeted amounts, carryover, and holds; move accounts on/off budget; create income categories — operations the API supports but existing MCP wrappers don't expose.
- **Mutation safety.** Every write is saved as a `{before, request, after}` JSON backup in the temp directory, write tools are opt-in via `ACTUAL_ENABLE_WRITE=true`, and destructive tools carry MCP `destructiveHint` annotations.
- **Defensive name handling.** Some MCP clients HTML-escape arguments (`&` → `&amp;`); names are unescaped before they reach Actual.

## Setup

```bash
npm install
npm run build
```

Configure via environment (see `.env.example`):

| Variable | Required | Purpose |
|---|---|---|
| `ACTUAL_SERVER_URL` | yes | Your actual-server instance URL |
| `ACTUAL_PASSWORD` | yes | Server login password |
| `ACTUAL_BUDGET_SYNC_ID` | yes | Settings → Show advanced settings → Sync ID |
| `ACTUAL_DATA_DIR` | yes | Local cache directory for the budget file |
| `ACTUAL_BUDGET_ENCRYPTION_PASSWORD` | no | Only for end-to-end encrypted files |
| `ACTUAL_ENABLE_WRITE` | no | Write tools registered only when exactly `true` |

Claude Code / Cursor MCP config:

```json
{
  "mcpServers": {
    "actual-budget": {
      "command": "node",
      "args": ["/path/to/actual-mcp-server/dist/index.js"],
      "env": {
        "ACTUAL_SERVER_URL": "https://actual.example.com",
        "ACTUAL_PASSWORD": "...",
        "ACTUAL_BUDGET_SYNC_ID": "...",
        "ACTUAL_DATA_DIR": "/path/to/cache",
        "ACTUAL_ENABLE_WRITE": "true"
      }
    }
  }
}
```

## Tools

**Always on (read/admin):**
`actual_get_accounts`, `actual_get_categories`, `actual_get_budget_months`, `actual_get_budget_month`, `actual_get_transactions`, `actual_get_payees`, `actual_get_server_version`, `actual_sync_now`, `actual_reload_budget`

**With `ACTUAL_ENABLE_WRITE=true`:**
`actual_update_account` (incl. on/off budget), `actual_create_category` (incl. `is_income`), `actual_create_category_group` (with create-then-update workaround for the engine dropping `is_income` on create), `actual_update_category`, `actual_delete_category`, `actual_set_budget_amount`, `actual_set_budget_carryover`, `actual_hold_budget_for_next_month`, `actual_reset_budget_hold`

Amounts in write tools are major currency units (`123.45`); Actual stores minor units (cents) and conversion happens at the boundary. Read tools currently return Actual's raw minor-unit integers except account balances, which are converted.

## Roadmap

- Transaction writes: `addTransactions`, `importTransactions` (with `imported_id` dedup), update, delete
- Payee writes and `mergePayees`
- Rules, schedules, tags, notes
- `aqlQuery` / query-builder tool for reporting (spending by category, monthly summaries)
- `batchBudgetUpdates` wrapper for bulk envelope edits
- Streamable HTTP transport

## License

Dual-licensed: [AGPL-3.0-only](./LICENSE) for open-source use, with a [commercial license](./COMMERCIAL.md) available. Contact hello@nightsquawk.tech.
