import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ActualEngine } from "../services/engine.js";
import { formatActualError } from "../services/errors.js";
import { writeMutationBackup } from "../services/backups.js";
import { errorResponse, makeToolResponse, toMinorUnits } from "./format.js";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/**
 * The engine's api/transaction-update and api/transaction-delete handlers
 * return without awaiting their internal transactions-batch-update call
 * (api.ts: `return handlers['transactions-batch-update'](diff)['updated']`
 * indexes the unawaited promise), so the write lands asynchronously a beat
 * after the API call resolves. Poll until the change is visible so our
 * response and backup reflect the applied state.
 */
async function settle<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let i = 0; i < 20 && !done(value); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  return value;
}

const TXN_SELECT = [
  "id",
  "date",
  "amount",
  "payee",
  "payee.name",
  "category",
  "category.name",
  "account",
  "account.name",
  "notes",
  "cleared"
];

export function registerTransactionTools(server: McpServer, engine: ActualEngine, enableWrite: boolean): void {
  server.registerTool(
    "actual_get_transactions",
    {
      title: "List Actual Transactions",
      description: "List transactions for one account in a date range. Amounts are integers in minor units (cents); negative is an expense. For cross-account or filtered lookups use actual_search_transactions instead.",
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
    "actual_search_transactions",
    {
      title: "Search Actual Transactions",
      description: "Search transactions across ALL accounts with optional filters: payee name substring, exact amount, category, account, date range, uncategorized-only. Returns payee/category/account names alongside IDs. Amounts in results are minor units (cents).",
      inputSchema: {
        payee: z.string().optional().describe("Case-insensitive payee name substring, e.g. 'amazon'"),
        amount: z.number().optional().describe("Exact amount in major units; negative for expenses, e.g. -14.14"),
        category_id: z.string().optional().describe("Only transactions in this category"),
        account_id: z.string().optional().describe("Only transactions in this account"),
        start_date: DATE.optional().describe("Range start, YYYY-MM-DD"),
        end_date: DATE.optional().describe("Range end, YYYY-MM-DD"),
        uncategorized_only: z.boolean().default(false).describe("Only transactions with no category (on-budget cleanup)"),
        limit: z.number().int().min(1).max(500).default(50).describe("Max results, newest first")
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: {
      payee?: string;
      amount?: number;
      category_id?: string;
      account_id?: string;
      start_date?: string;
      end_date?: string;
      uncategorized_only: boolean;
      limit: number;
    }) => {
      try {
        const data = await engine.read(async (api) => {
          const filters: Record<string, unknown>[] = [];
          if (params.payee) filters.push({ "payee.name": { $like: `%${params.payee}%` } });
          if (params.amount !== undefined) filters.push({ amount: toMinorUnits(params.amount) });
          if (params.category_id) filters.push({ category: params.category_id });
          if (params.account_id) filters.push({ account: params.account_id });
          if (params.start_date) filters.push({ date: { $gte: params.start_date } });
          if (params.end_date) filters.push({ date: { $lte: params.end_date } });
          if (params.uncategorized_only) filters.push({ category: null, "account.offbudget": false });

          let query = api.q("transactions").options({ splits: "inline" });
          for (const f of filters) query = query.filter(f);
          query = query.select(TXN_SELECT).orderBy({ date: "desc" }).limit(params.limit);

          const result = (await api.aqlQuery(query)) as { data: unknown[] };
          return result.data;
        });
        return makeToolResponse({ count: data.length, transactions: data });
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

  if (!enableWrite) return;

  server.registerTool(
    "actual_add_transaction",
    {
      title: "Add Actual Transaction",
      description: "Add a single transaction to an account. Amount is in major units; negative for expenses (e.g. -14.14). Sensitive edit: call only after explicit human authorization. The request is saved to a temp backup file.",
      inputSchema: {
        account_id: z.string().describe("Account ID"),
        date: DATE.describe("Transaction date, YYYY-MM-DD"),
        amount: z.number().describe("Amount in major units; negative = expense"),
        payee_name: z.string().optional().describe("Payee by name (created if new)"),
        payee_id: z.string().optional().describe("Payee by ID (takes precedence over payee_name)"),
        category_id: z.string().optional().describe("Category ID"),
        notes: z.string().optional(),
        cleared: z.boolean().optional(),
        imported_id: z.string().optional().describe("External ID for dedup on later imports")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (params: {
      account_id: string;
      date: string;
      amount: number;
      payee_name?: string;
      payee_id?: string;
      category_id?: string;
      notes?: string;
      cleared?: boolean;
      imported_id?: string;
    }) => {
      try {
        const txn = {
          date: params.date,
          amount: toMinorUnits(params.amount),
          ...(params.payee_id ? { payee: params.payee_id } : {}),
          ...(params.payee_name && !params.payee_id ? { payee_name: params.payee_name } : {}),
          ...(params.category_id ? { category: params.category_id } : {}),
          ...(params.notes !== undefined ? { notes: params.notes } : {}),
          ...(params.cleared !== undefined ? { cleared: params.cleared } : {}),
          ...(params.imported_id ? { imported_id: params.imported_id } : {})
        };
        const result = await engine.write((api) =>
          api.addTransactions(params.account_id, [txn], { learnCategories: false, runTransfers: true })
        );
        const backupFile = await writeMutationBackup({
          operation: "actual_add_transaction",
          before: null,
          request: { account_id: params.account_id, transaction: txn },
          after: result
        });
        return makeToolResponse({ backup_file: backupFile, added: result });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_import_transactions",
    {
      title: "Import Actual Transactions (Batch)",
      description: "Batch-import transactions into an account with reconciliation: rows with an imported_id dedupe against existing transactions (re-importing updates instead of duplicating). Amounts in major units; negative = expense. Set dry_run=true to preview what would be added/updated without writing. Sensitive edit: call only after explicit human authorization.",
      inputSchema: {
        account_id: z.string().describe("Account ID"),
        transactions: z
          .array(
            z.object({
              date: DATE,
              amount: z.number().describe("Major units; negative = expense"),
              payee_name: z.string().optional(),
              imported_id: z.string().optional().describe("Stable external ID for dedup"),
              category_id: z.string().optional(),
              notes: z.string().optional(),
              cleared: z.boolean().optional()
            })
          )
          .min(1)
          .max(1000),
        default_cleared: z.boolean().optional().describe("Cleared flag for rows that do not set one"),
        dry_run: z.boolean().default(false).describe("true = report the reconciliation without writing")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: {
      account_id: string;
      transactions: Array<{
        date: string;
        amount: number;
        payee_name?: string;
        imported_id?: string;
        category_id?: string;
        notes?: string;
        cleared?: boolean;
      }>;
      default_cleared?: boolean;
      dry_run: boolean;
    }) => {
      try {
        const rows = params.transactions.map((t) => ({
          account: params.account_id,
          date: t.date,
          amount: toMinorUnits(t.amount),
          ...(t.payee_name ? { payee_name: t.payee_name } : {}),
          ...(t.imported_id ? { imported_id: t.imported_id } : {}),
          ...(t.category_id ? { category: t.category_id } : {}),
          ...(t.notes !== undefined ? { notes: t.notes } : {}),
          ...(t.cleared !== undefined ? { cleared: t.cleared } : {})
        }));
        const opts = {
          ...(params.default_cleared !== undefined ? { defaultCleared: params.default_cleared } : {}),
          ...(params.dry_run ? { isPreview: true } : {})
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
        const result = await engine.write((api) => api.importTransactions(params.account_id, rows, opts));
        const backupFile = await writeMutationBackup({
          operation: "actual_import_transactions",
          request: { account_id: params.account_id, rows: rows.length, dry_run: params.dry_run },
          after: result
        });
        return makeToolResponse({
          backup_file: backupFile,
          dry_run: params.dry_run,
          added: result.added?.length ?? 0,
          updated: result.updated?.length ?? 0,
          errors: result.errors ?? []
        });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_update_transaction",
    {
      title: "Update Actual Transaction",
      description: "Update a transaction: recategorize (category_id), change payee, notes, date, amount, or cleared status. Amount in major units; negative = expense. Sensitive edit: call only after explicit human authorization. Before/after are saved to a temp backup file.",
      inputSchema: {
        id: z.string().describe("Transaction ID (from actual_get_transactions or actual_search_transactions)"),
        category_id: z.string().nullable().optional().describe("New category ID; null clears the category"),
        payee_id: z.string().optional().describe("New payee ID"),
        notes: z.string().optional(),
        date: DATE.optional(),
        amount: z.number().optional().describe("New amount in major units; negative = expense"),
        cleared: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: {
      id: string;
      category_id?: string | null;
      payee_id?: string;
      notes?: string;
      date?: string;
      amount?: number;
      cleared?: boolean;
    }) => {
      try {
        const fields = {
          ...(params.category_id !== undefined ? { category: params.category_id ?? undefined } : {}),
          ...(params.payee_id !== undefined ? { payee: params.payee_id } : {}),
          ...(params.notes !== undefined ? { notes: params.notes } : {}),
          ...(params.date !== undefined ? { date: params.date } : {}),
          ...(params.amount !== undefined ? { amount: toMinorUnits(params.amount) } : {}),
          ...(params.cleared !== undefined ? { cleared: params.cleared } : {})
        };
        if (Object.keys(fields).length === 0) {
          return errorResponse("Provide at least one field to update.");
        }

        const result = await engine.write(async (api) => {
          const query = api.q("transactions").filter({ id: params.id }).select(TXN_SELECT).options({ splits: "inline" });
          const read = async () => ((await api.aqlQuery(query)) as { data: unknown[] }).data[0] ?? null;
          const before = await read();
          await api.updateTransaction(params.id, fields);
          const after = await settle(read, (row) => JSON.stringify(row) !== JSON.stringify(before));
          return { before, after };
        });
        const backupFile = await writeMutationBackup({
          operation: "actual_update_transaction",
          before: result.before,
          request: { id: params.id, fields },
          after: result.after
        });
        return makeToolResponse({ backup_file: backupFile, transaction: result.after });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_delete_transaction",
    {
      title: "Delete Actual Transaction",
      description: "Delete a transaction. Destructive: call only after explicit human authorization. The deleted record is saved to a temp backup file.",
      inputSchema: {
        id: z.string().describe("Transaction ID to delete")
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async (params: { id: string }) => {
      try {
        const result = await engine.write(async (api) => {
          const query = api.q("transactions").filter({ id: params.id }).select(TXN_SELECT).options({ splits: "inline" });
          const read = async () => ((await api.aqlQuery(query)) as { data: unknown[] }).data[0] ?? null;
          const before = await read();
          await api.deleteTransaction(params.id);
          await settle(read, (row) => row === null);
          return before;
        });
        const backupFile = await writeMutationBackup({
          operation: "actual_delete_transaction",
          before: result,
          request: params
        });
        return makeToolResponse({ backup_file: backupFile, deleted: params.id });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );
}
