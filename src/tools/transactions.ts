import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ActualEngine } from "../services/engine.js";
import { formatActualError } from "../services/errors.js";
import { errorResponse, makeToolResponse } from "./format.js";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export function registerTransactionTools(server: McpServer, engine: ActualEngine): void {
  server.registerTool(
    "actual_get_transactions",
    {
      title: "List Actual Transactions",
      description: "List transactions for one account in a date range. Amounts are integers in minor units (cents); negative is an expense.",
      inputSchema: {
        account_id: z.string().describe("Account ID (from actual_get_accounts)"),
        start_date: DATE.describe("Range start, YYYY-MM-DD"),
        end_date: DATE.describe("Range end, YYYY-MM-DD")
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: { account_id: string; start_date: string; end_date: string }) => {
      try {
        const transactions = await engine.read((api) =>
          api.getTransactions(params.account_id, params.start_date, params.end_date)
        );
        return makeToolResponse({ count: transactions.length, transactions });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_get_payees",
    {
      title: "List Actual Payees",
      description: "List all payees.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      try {
        const payees = await engine.read((api) => api.getPayees());
        return makeToolResponse({ payees });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  // TODO: transaction writes (add/import/update/delete), payee writes,
  // mergePayees, rules, schedules, tags, notes, aqlQuery. See ROADMAP in
  // README.md — port these with the same engine.write + backup pattern.
}
