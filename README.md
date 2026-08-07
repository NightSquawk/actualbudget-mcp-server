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

## Tools (53)

**Always on (read/admin):**
- `actual_get_accounts`, `actual_get_categories`, `actual_get_budget_months`, `actual_get_budget_month`
- `actual_get_transactions`, `actual_search_transactions` (cross-account, filters: payee substring / amount / category / account / date range / uncategorized-only)
- `actual_get_payees`, `actual_get_common_payees`, `actual_get_payee_rules`, `actual_get_rules`, `actual_get_tags`, `actual_get_schedules`, `actual_get_note`
- `actual_query` — general read-only AQL access to any table with filters, joins, groupBy, and aggregates (spending-by-category reports in one call)
- `actual_get_server_version`, `actual_sync_now`, `actual_reload_budget`, `actual_prune_stale` (dry-run by default)

**With `ACTUAL_ENABLE_WRITE=true`:**
- Accounts: `actual_create_account`, `actual_update_account` (incl. on/off budget), `actual_close_account` (transfer-aware), `actual_reopen_account`, `actual_delete_account`
- Categories: `actual_create_category` (incl. `is_income`), `actual_update_category`, `actual_delete_category`, `actual_create_category_group` (create-then-update workaround for the engine dropping `is_income` on create), `actual_update_category_group`, `actual_delete_category_group`
- Budget envelope: `actual_set_budget_amount`, `actual_set_budget_amounts` (batch, via `batchBudgetUpdates`), `actual_set_budget_carryover`, `actual_hold_budget_for_next_month`, `actual_reset_budget_hold`
- Transactions: `actual_add_transaction`, `actual_update_transaction` (recategorize, payee, notes, date, amount, cleared), `actual_delete_transaction`, `actual_import_transactions` (batch with `imported_id` dedup and dry-run preview)
- Payees: `actual_create_payee`, `actual_update_payee`, `actual_merge_payees`, `actual_delete_payee`
- Rules: `actual_create_rule`, `actual_update_rule`, `actual_delete_rule`
- Schedules: `actual_create_schedule`, `actual_update_schedule`, `actual_delete_schedule`
- Tags: `actual_create_tag`, `actual_update_tag`, `actual_delete_tag`
- Notes: `actual_update_note`
- Bank sync: `actual_run_bank_sync` (one account or all)

Amounts in tool inputs are major currency units (`123.45`); Actual stores minor units (cents) and conversion happens at the boundary. Transaction lists return raw minor-unit integers; account `balance` and `balance_current` are converted to major units (`balance_current: null` means the account has never bank-synced). `totalBudgeted` in `actual_get_budget_month` is normalized to agree in sign with its per-group siblings (the engine reports it negated internally).

Transaction update/delete compensate for an upstream engine quirk: the engine's handlers return before their internal batch write is applied, so this server polls until the change is visible before responding — responses and backups always reflect applied state. The same one-operation lag can make a balance read immediately after `actual_close_account` (with transfer) show the pre-transfer value; the closed state itself is immediate.

## Known limitations

- Transaction splits (subtransactions) are not exposed; use the Actual UI
- Single-budget by design: `loadBudget`/`runImport`/`getBudgets` multi-file management is intentionally out of scope (one server instance per budget file)
- `actual_run_bank_sync` is registered but exercised only against the engine, not against live GoCardless/SimpleFIN providers
- Streamable HTTP transport not yet implemented (stdio only)

## License

Dual-licensed: [AGPL-3.0-only](./LICENSE) for open-source use, with a [commercial license](./COMMERCIAL.md) available. Contact hello@nightsquawk.tech.
