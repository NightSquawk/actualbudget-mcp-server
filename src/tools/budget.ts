import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ActualEngine } from "../services/engine.js";
import { formatActualError } from "../services/errors.js";
import { writeMutationBackup } from "../services/backups.js";
import { errorResponse, makeToolResponse, toMinorUnits } from "./format.js";

const MONTH = z.string().regex(/^\d{4}-\d{2}$/, "Use YYYY-MM").describe("Budget month as YYYY-MM");

export function registerBudgetTools(server: McpServer, engine: ActualEngine, enableWrite: boolean): void {
  server.registerTool(
    "actual_get_budget_months",
    {
      title: "List Actual Budget Months",
      description: "List all months that have budget data, as YYYY-MM strings.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      try {
        const months = await engine.read((api) => api.getBudgetMonths());
        return makeToolResponse({ months });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_get_budget_month",
    {
      title: "Get Actual Budget Month",
      description: "Get the full budget envelope for one month: income, amount to budget, and per-category budgeted/spent/balance. Amounts are integers in minor units (cents).",
      inputSchema: { month: MONTH },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: { month: string }) => {
      try {
        const budget = await engine.read((api) => api.getBudgetMonth(params.month));
        return makeToolResponse({ budget });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  if (!enableWrite) return;

  server.registerTool(
    "actual_set_budget_amount",
    {
      title: "Set Actual Budget Amount",
      description: "Set the budgeted amount for a category in a month. The amount is in major currency units (e.g. 123.45) and converted to cents internally. This replaces a manual step the third-party actual-mcp could not do. Sensitive edit: call only after explicit human authorization.",
      inputSchema: {
        month: MONTH,
        category_id: z.string().describe("Category ID"),
        amount: z.number().describe("Budgeted amount in major currency units, e.g. 250 or 123.45")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: { month: string; category_id: string; amount: number }) => {
      try {
        const value = toMinorUnits(params.amount);
        await engine.write((api) => api.setBudgetAmount(params.month, params.category_id, value));
        const backupFile = await writeMutationBackup({
          operation: "actual_set_budget_amount",
          request: { ...params, value_minor_units: value }
        });
        return makeToolResponse({
          backup_file: backupFile,
          month: params.month,
          category_id: params.category_id,
          amount: params.amount
        });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_set_budget_carryover",
    {
      title: "Set Actual Budget Carryover",
      description: "Enable or disable rollover of a category's leftover balance into the next month. Expense categories only. Sensitive edit: call only after explicit human authorization.",
      inputSchema: {
        month: MONTH,
        category_id: z.string().describe("Category ID"),
        carryover: z.boolean().describe("true to roll the balance over, false to stop")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: { month: string; category_id: string; carryover: boolean }) => {
      try {
        await engine.write((api) => api.setBudgetCarryover(params.month, params.category_id, params.carryover));
        const backupFile = await writeMutationBackup({ operation: "actual_set_budget_carryover", request: params });
        return makeToolResponse({ backup_file: backupFile, ...params });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_hold_budget_for_next_month",
    {
      title: "Hold Budget For Next Month",
      description: "Hold part of this month's to-budget amount for next month. Amount is in major currency units and must be positive. Sensitive edit: call only after explicit human authorization.",
      inputSchema: {
        month: MONTH,
        amount: z.number().positive().describe("Amount to hold, in major currency units")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (params: { month: string; amount: number }) => {
      try {
        const held = await engine.write((api) =>
          api.holdBudgetForNextMonth(params.month, toMinorUnits(params.amount))
        );
        const backupFile = await writeMutationBackup({ operation: "actual_hold_budget_for_next_month", request: params });
        return makeToolResponse({ backup_file: backupFile, held, ...params });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_reset_budget_hold",
    {
      title: "Reset Budget Hold",
      description: "Remove any hold on a month's to-budget amount. Sensitive edit: call only after explicit human authorization.",
      inputSchema: { month: MONTH },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: { month: string }) => {
      try {
        await engine.write((api) => api.resetBudgetHold(params.month));
        const backupFile = await writeMutationBackup({ operation: "actual_reset_budget_hold", request: params });
        return makeToolResponse({ backup_file: backupFile, month: params.month });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );
}
