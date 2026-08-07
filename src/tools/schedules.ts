import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ActualEngine } from "../services/engine.js";
import { formatActualError } from "../services/errors.js";
import { writeMutationBackup } from "../services/backups.js";
import { errorResponse, makeToolResponse, toMinorUnits } from "./format.js";

// Schedule dates are either a plain YYYY-MM-DD string (one-off) or a recur
// config object like {start: "2026-09-01", frequency: "monthly",
// interval: 1, patterns: []}. Passed through loosely; the engine validates.
const SCHEDULE_DATE = z.union([z.string(), z.record(z.unknown())]);

function toMinorAmount(amount: number | { num1: number; num2: number }) {
  return typeof amount === "number"
    ? toMinorUnits(amount)
    : { num1: toMinorUnits(amount.num1), num2: toMinorUnits(amount.num2) };
}

export function registerScheduleTools(server: McpServer, engine: ActualEngine, enableWrite: boolean): void {
  server.registerTool(
    "actual_get_schedules",
    {
      title: "List Actual Schedules",
      description: "List all scheduled transactions (recurring bills, transfers, income). Amounts are minor units (cents).",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      try {
        const schedules = await engine.read((api) => api.getSchedules());
        return makeToolResponse({ count: schedules.length, schedules });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  if (!enableWrite) return;

  server.registerTool(
    "actual_create_schedule",
    {
      title: "Create Actual Schedule",
      description: "Create a scheduled transaction. Amount in major units (negative = expense); amount_op 'isbetween' takes {num1, num2}. Date is YYYY-MM-DD for one-offs or a recur config object ({start, frequency: 'monthly'|'weekly'|'yearly'|'daily', interval, patterns}). Sensitive edit: call only after explicit human authorization.",
      inputSchema: {
        name: z.string().optional().describe("Schedule name"),
        account_id: z.string().describe("Account the schedule posts to"),
        payee_id: z.string().optional(),
        amount: z
          .union([z.number(), z.object({ num1: z.number(), num2: z.number() })])
          .describe("Amount in major units; object {num1,num2} for isbetween"),
        amount_op: z.enum(["is", "isapprox", "isbetween"]).default("is"),
        date: SCHEDULE_DATE,
        posts_transaction: z.boolean().default(false).describe("Automatically enter the transaction when due")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (params: {
      name?: string;
      account_id: string;
      payee_id?: string;
      amount: number | { num1: number; num2: number };
      amount_op: "is" | "isapprox" | "isbetween";
      date: unknown;
      posts_transaction: boolean;
    }) => {
      try {
        const request = {
          ...(params.name !== undefined ? { name: params.name } : {}),
          account: params.account_id,
          ...(params.payee_id ? { payee: params.payee_id } : {}),
          amount: toMinorAmount(params.amount),
          amountOp: params.amount_op,
          date: params.date,
          posts_transaction: params.posts_transaction
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
        const id = await engine.write((api) => api.createSchedule(request));
        const backupFile = await writeMutationBackup({ operation: "actual_create_schedule", before: null, request, after: { id } });
        return makeToolResponse({ backup_file: backupFile, id });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_update_schedule",
    {
      title: "Update Actual Schedule",
      description: "Update a schedule's fields (same shapes as actual_create_schedule; amount in major units). Sensitive edit: call only after explicit human authorization.",
      inputSchema: {
        id: z.string().describe("Schedule ID"),
        name: z.string().optional(),
        account_id: z.string().optional(),
        payee_id: z.string().optional(),
        amount: z.union([z.number(), z.object({ num1: z.number(), num2: z.number() })]).optional(),
        amount_op: z.enum(["is", "isapprox", "isbetween"]).optional(),
        date: SCHEDULE_DATE.optional(),
        posts_transaction: z.boolean().optional(),
        reset_next_date: z.boolean().default(false).describe("Recompute the next occurrence from the new date rule")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: {
      id: string;
      name?: string;
      account_id?: string;
      payee_id?: string;
      amount?: number | { num1: number; num2: number };
      amount_op?: "is" | "isapprox" | "isbetween";
      date?: unknown;
      posts_transaction?: boolean;
      reset_next_date: boolean;
    }) => {
      try {
        const fields = {
          ...(params.name !== undefined ? { name: params.name } : {}),
          ...(params.account_id !== undefined ? { account: params.account_id } : {}),
          ...(params.payee_id !== undefined ? { payee: params.payee_id } : {}),
          ...(params.amount !== undefined ? { amount: toMinorAmount(params.amount) } : {}),
          ...(params.amount_op !== undefined ? { amountOp: params.amount_op } : {}),
          ...(params.date !== undefined ? { date: params.date } : {}),
          ...(params.posts_transaction !== undefined ? { posts_transaction: params.posts_transaction } : {})
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
        if (Object.keys(fields).length === 0) {
          return errorResponse("Provide at least one field to update.");
        }
        const before = await engine.read(async (api) => (await api.getSchedules()).find((s) => s.id === params.id) ?? null);
        await engine.write((api) => api.updateSchedule(params.id, fields, params.reset_next_date));
        const backupFile = await writeMutationBackup({ operation: "actual_update_schedule", before, request: params });
        return makeToolResponse({ backup_file: backupFile, id: params.id });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_delete_schedule",
    {
      title: "Delete Actual Schedule",
      description: "Delete a scheduled transaction. Destructive: call only after explicit human authorization.",
      inputSchema: { id: z.string().describe("Schedule ID to delete") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async (params: { id: string }) => {
      try {
        const before = await engine.read(async (api) => (await api.getSchedules()).find((s) => s.id === params.id) ?? null);
        await engine.write((api) => api.deleteSchedule(params.id));
        const backupFile = await writeMutationBackup({ operation: "actual_delete_schedule", before, request: params });
        return makeToolResponse({ backup_file: backupFile, deleted: params.id });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );
}
