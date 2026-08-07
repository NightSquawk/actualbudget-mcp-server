import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ActualEngine } from "../services/engine.js";
import { formatActualError } from "../services/errors.js";
import { writeMutationBackup } from "../services/backups.js";
import { unescapeName } from "../services/names.js";
import { errorResponse, makeToolResponse, toMajorUnits } from "./format.js";

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
          return Promise.all(
            list.map(async (account) => ({
              ...account,
              balance: toMajorUnits(await api.getAccountBalance(account.id))
            }))
          );
        });
        return makeToolResponse({ accounts });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  if (!enableWrite) return;

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
          const before = (await api.getAccounts()).find((a) => a.id === params.id) ?? null;
          await api.updateAccount(params.id, fields);
          const after = (await api.getAccounts()).find((a) => a.id === params.id) ?? null;
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
