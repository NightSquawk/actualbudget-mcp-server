import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ActualEngine } from "../services/engine.js";
import { formatActualError } from "../services/errors.js";
import { writeMutationBackup } from "../services/backups.js";
import { unescapeName } from "../services/names.js";
import { errorResponse, makeToolResponse } from "./format.js";

export function registerPayeeTools(server: McpServer, engine: ActualEngine, enableWrite: boolean): void {
  server.registerTool(
    "actual_get_common_payees",
    {
      title: "List Common Actual Payees",
      description: "List the most frequently used payees (the shortlist Actual suggests first).",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      try {
        const payees = await engine.read((api) => api.getCommonPayees());
        return makeToolResponse({ payees });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_get_payee_rules",
    {
      title: "List Rules For Payee",
      description: "List the rules attached to a specific payee.",
      inputSchema: { payee_id: z.string().describe("Payee ID") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: { payee_id: string }) => {
      try {
        const rules = await engine.read((api) => api.getPayeeRules(params.payee_id));
        return makeToolResponse({ count: rules.length, rules });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  if (!enableWrite) return;

  server.registerTool(
    "actual_create_payee",
    {
      title: "Create Actual Payee",
      description: "Create a payee. Sensitive edit: call only after explicit human authorization.",
      inputSchema: { name: z.string().describe("Payee name (entity-escaped input is unescaped)") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (params: { name: string }) => {
      try {
        const request = { name: unescapeName(params.name) };
        const id = await engine.write((api) => api.createPayee(request));
        const backupFile = await writeMutationBackup({ operation: "actual_create_payee", before: null, request, after: { id } });
        return makeToolResponse({ backup_file: backupFile, id, ...request });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_update_payee",
    {
      title: "Update Actual Payee",
      description: "Rename a payee. Sensitive edit: call only after explicit human authorization.",
      inputSchema: {
        id: z.string().describe("Payee ID"),
        name: z.string().describe("New payee name")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: { id: string; name: string }) => {
      try {
        const fields = { name: unescapeName(params.name) };
        const before = await engine.read(async (api) => (await api.getPayees()).find((p) => p.id === params.id) ?? null);
        await engine.write((api) => api.updatePayee(params.id, fields));
        const backupFile = await writeMutationBackup({ operation: "actual_update_payee", before, request: { id: params.id, fields } });
        return makeToolResponse({ backup_file: backupFile, id: params.id, updated: fields });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_merge_payees",
    {
      title: "Merge Actual Payees",
      description: "Merge one or more payees into a target payee: their transactions move to the target and the merged payees are removed. Destructive: call only after explicit human authorization.",
      inputSchema: {
        target_id: z.string().describe("Payee that survives"),
        merge_ids: z.array(z.string()).min(1).describe("Payees to merge into the target (removed afterward)")
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async (params: { target_id: string; merge_ids: string[] }) => {
      try {
        const before = await engine.read(async (api) => {
          const all = await api.getPayees();
          return all.filter((p) => p.id === params.target_id || params.merge_ids.includes(p.id));
        });
        await engine.write((api) => api.mergePayees(params.target_id, params.merge_ids));
        const backupFile = await writeMutationBackup({ operation: "actual_merge_payees", before, request: params });
        return makeToolResponse({ backup_file: backupFile, target_id: params.target_id, merged: params.merge_ids.length });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_delete_payee",
    {
      title: "Delete Actual Payee",
      description: "Delete a payee. Destructive: call only after explicit human authorization. The deleted record is saved to a temp backup file.",
      inputSchema: { id: z.string().describe("Payee ID to delete") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async (params: { id: string }) => {
      try {
        const before = await engine.read(async (api) => (await api.getPayees()).find((p) => p.id === params.id) ?? null);
        await engine.write((api) => api.deletePayee(params.id));
        const backupFile = await writeMutationBackup({ operation: "actual_delete_payee", before, request: params });
        return makeToolResponse({ backup_file: backupFile, deleted: params.id });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );
}
