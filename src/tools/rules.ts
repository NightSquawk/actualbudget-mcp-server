import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ActualEngine } from "../services/engine.js";
import { formatActualError } from "../services/errors.js";
import { writeMutationBackup } from "../services/backups.js";
import { errorResponse, makeToolResponse } from "./format.js";

// Conditions/actions are passed through to the engine loosely typed: the rule
// schema is deep (per-field ops, oneOf arrays, isbetween ranges) and the
// engine validates on its side. Example condition: {field: "payee", op: "is",
// value: "<payee-id>"}. Example action: {field: "category", op: "set",
// value: "<category-id>"}.
const CONDITION = z
  .object({
    field: z.string(),
    op: z.string(),
    value: z.unknown(),
    options: z.record(z.unknown()).optional()
  })
  .passthrough();

const ACTION = z
  .object({
    field: z.string().optional(),
    op: z.string(),
    value: z.unknown()
  })
  .passthrough();

type RuleInput = {
  stage: "pre" | "post" | null;
  conditions_op: "and" | "or";
  conditions: Array<Record<string, unknown>>;
  actions: Array<Record<string, unknown>>;
};

// The engine's RuleEntity uses camelCase conditionsOp and typed arrays; cast
// at this one boundary rather than re-declaring the whole rule type union.
function toEngineRule(params: RuleInput) {
  return {
    stage: params.stage,
    conditionsOp: params.conditions_op,
    conditions: params.conditions,
    actions: params.actions
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

export function registerRuleTools(server: McpServer, engine: ActualEngine, enableWrite: boolean): void {
  server.registerTool(
    "actual_get_rules",
    {
      title: "List Actual Rules",
      description: "List all import/auto-categorization rules with their conditions and actions.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      try {
        const rules = await engine.read((api) => api.getRules());
        return makeToolResponse({ count: rules.length, rules });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  if (!enableWrite) return;

  server.registerTool(
    "actual_create_rule",
    {
      title: "Create Actual Rule",
      description: "Create an auto-categorization/import rule. Conditions match transactions (e.g. {field:'payee', op:'is', value:'<payee-id>'} or {field:'imported_payee', op:'contains', value:'AMAZON'}); actions modify them (e.g. {field:'category', op:'set', value:'<category-id>'}). Sensitive edit: call only after explicit human authorization.",
      inputSchema: {
        stage: z.enum(["pre", "post"]).nullable().default(null).describe("Rule stage; null = default stage"),
        conditions_op: z.enum(["and", "or"]).default("and").describe("How multiple conditions combine"),
        conditions: z.array(CONDITION).min(1),
        actions: z.array(ACTION).min(1)
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (params: RuleInput) => {
      try {
        const created = await engine.write((api) => api.createRule(toEngineRule(params)));
        const backupFile = await writeMutationBackup({
          operation: "actual_create_rule",
          before: null,
          request: params,
          after: created
        });
        return makeToolResponse({ backup_file: backupFile, rule: created });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_update_rule",
    {
      title: "Update Actual Rule",
      description: "Replace an existing rule's stage, conditions, and actions (full replacement, not a patch). Sensitive edit: call only after explicit human authorization.",
      inputSchema: {
        id: z.string().describe("Rule ID (from actual_get_rules)"),
        stage: z.enum(["pre", "post"]).nullable().default(null),
        conditions_op: z.enum(["and", "or"]).default("and"),
        conditions: z.array(CONDITION).min(1),
        actions: z.array(ACTION).min(1)
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: RuleInput & { id: string }) => {
      try {
        const result = await engine.write(async (api) => {
          const before = (await api.getRules()).find((r) => r.id === params.id) ?? null;
          const after = await api.updateRule({ id: params.id, ...toEngineRule(params) });
          return { before, after };
        });
        const backupFile = await writeMutationBackup({
          operation: "actual_update_rule",
          before: result.before,
          request: params,
          after: result.after
        });
        return makeToolResponse({ backup_file: backupFile, rule: result.after });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_delete_rule",
    {
      title: "Delete Actual Rule",
      description: "Delete a rule. Destructive: call only after explicit human authorization. The deleted rule is saved to a temp backup file.",
      inputSchema: {
        id: z.string().describe("Rule ID to delete")
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async (params: { id: string }) => {
      try {
        const result = await engine.write(async (api) => {
          const before = (await api.getRules()).find((r) => r.id === params.id) ?? null;
          const deleted = await api.deleteRule(params.id);
          return { before, deleted };
        });
        const backupFile = await writeMutationBackup({
          operation: "actual_delete_rule",
          before: result.before,
          request: params
        });
        return makeToolResponse({ backup_file: backupFile, deleted: result.deleted });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );
}
