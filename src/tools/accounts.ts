import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ActualEngine } from "../services/engine.js";
import { formatActualError } from "../services/errors.js";
import { writeMutationBackup } from "../services/backups.js";
import { unescapeName } from "../services/names.js";
import { errorResponse, makeToolResponse, toMajorUnits } from "./format.js";

type ActualApi = typeof import("@actual-app/api");
type RawAccount = Awaited<ReturnType<ActualApi["getAccounts"]>>[number];

/**
 * Normalize the two balance fields to major units and consistent semantics:
 * - balance: computed from transactions (always present)
 * - balance_current: the bank-sync provider's last reported balance; null
 *   means the account has never bank-synced, not a fetch failure
 */
async function enrichAccount(api: ActualApi, account: RawAccount) {
  const raw = account as RawAccount & { balance_current?: number | null };
  return {
    ...account,
    balance: toMajorUnits(await api.getAccountBalance(account.id)),
    balance_current: raw.balance_current == null ? null : toMajorUnits(raw.balance_current)
  };
}

export function registerAccountTools(server: McpServer, engine: ActualEngine, enableWrite: boolean): void {
  server.registerTool(
    "actual_get_accounts",
    {
      title: "List Actual Accounts",
      description: "List all accounts with their current balances (in major currency units), off-budget flag, and closed flag.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      try {
        const accounts = await engine.read(async (api) => {
          const list = await api.getAccounts();
          return Promise.all(list.map((account) => enrichAccount(api, account)));
        });
        return makeToolResponse({ accounts });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  if (!enableWrite) return;

  server.registerTool(
    "actual_create_account",
    {
      title: "Create Actual Account",
      description: "Create a new account, optionally off-budget and with an opening balance (major units). Sensitive edit: call only after explicit human authorization.",
      inputSchema: {
        name: z.string().describe("Account name"),
        offbudget: z.boolean().default(false),
        initial_balance: z.number().default(0).describe("Opening balance in major units, e.g. 1500.00")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (params: { name: string; offbudget: boolean; initial_balance: number }) => {
      try {
        const request = { name: unescapeName(params.name), offbudget: params.offbudget };
        const id = await engine.write((api) =>
          api.createAccount(request, Math.round(params.initial_balance * 100))
        );
        const backupFile = await writeMutationBackup({
          operation: "actual_create_account",
          before: null,
          request: { ...request, initial_balance: params.initial_balance },
          after: { id }
        });
        return makeToolResponse({ backup_file: backupFile, id, ...request });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_close_account",
    {
      title: "Close Actual Account",
      description: "Close an account, optionally transferring its remaining balance to another account (and category, for on-budget transfers). Sensitive edit: call only after explicit human authorization.",
      inputSchema: {
        id: z.string().describe("Account ID to close"),
        transfer_account_id: z.string().optional().describe("Account to transfer the remaining balance to"),
        transfer_category_id: z.string().optional().describe("Category for the transfer (needed when moving on-budget money off-budget)")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: { id: string; transfer_account_id?: string; transfer_category_id?: string }) => {
      try {
        const before = await engine.read(async (api) => (await api.getAccounts()).find((a) => a.id === params.id) ?? null);
        await engine.write((api) => api.closeAccount(params.id, params.transfer_account_id, params.transfer_category_id));
        const backupFile = await writeMutationBackup({ operation: "actual_close_account", before, request: params });
        return makeToolResponse({ backup_file: backupFile, closed: params.id });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_reopen_account",
    {
      title: "Reopen Actual Account",
      description: "Reopen a closed account. Sensitive edit: call only after explicit human authorization.",
      inputSchema: { id: z.string().describe("Closed account ID") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: { id: string }) => {
      try {
        await engine.write((api) => api.reopenAccount(params.id));
        const backupFile = await writeMutationBackup({ operation: "actual_reopen_account", request: params });
        return makeToolResponse({ backup_file: backupFile, reopened: params.id });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_delete_account",
    {
      title: "Delete Actual Account",
      description: "Permanently delete an account AND all its transactions. Destructive and irreversible: call only after explicit human authorization; prefer actual_close_account unless the account was created by mistake.",
      inputSchema: { id: z.string().describe("Account ID to delete") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async (params: { id: string }) => {
      try {
        const before = await engine.read(async (api) => (await api.getAccounts()).find((a) => a.id === params.id) ?? null);
        await engine.write((api) => api.deleteAccount(params.id));
        const backupFile = await writeMutationBackup({ operation: "actual_delete_account", before, request: params });
        return makeToolResponse({ backup_file: backupFile, deleted: params.id });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_update_account",
    {
      title: "Update Actual Account",
      description: "Update an account's name, off-budget flag, or closed flag. This is how an account is moved on/off budget (the third-party actual-mcp had no tool for this). Sensitive edit: call only after explicit human authorization. The request is saved to a temp backup file.",
      inputSchema: {
        id: z.string().describe("Account ID"),
        name: z.string().optional().describe("New account name"),
        offbudget: z.boolean().optional().describe("true moves the account off-budget, false moves it on-budget"),
        closed: z.boolean().optional().describe("true closes the account, false reopens it")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: { id: string; name?: string; offbudget?: boolean; closed?: boolean }) => {
      try {
        const fields = {
          ...(params.name !== undefined ? { name: unescapeName(params.name) } : {}),
          ...(params.offbudget !== undefined ? { offbudget: params.offbudget } : {}),
          ...(params.closed !== undefined ? { closed: params.closed } : {})
        };
        if (Object.keys(fields).length === 0) {
          return errorResponse("Provide at least one of name, offbudget, or closed.");
        }

        const result = await engine.write(async (api) => {
          const findRaw = async () => (await api.getAccounts()).find((a) => a.id === params.id) ?? null;
          const before = await findRaw();
          await api.updateAccount(params.id, fields);
          const afterRaw = await findRaw();
          const after = afterRaw ? await enrichAccount(api, afterRaw) : null;
          return { before, after };
        });
        const backupFile = await writeMutationBackup({
          operation: "actual_update_account",
          before: result.before,
          request: { id: params.id, fields },
          after: result.after
        });
        return makeToolResponse({ backup_file: backupFile, account: result.after });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );
}
