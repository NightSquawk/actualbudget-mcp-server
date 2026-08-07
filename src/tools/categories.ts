import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ActualEngine } from "../services/engine.js";
import { formatActualError } from "../services/errors.js";
import { writeMutationBackup } from "../services/backups.js";
import { unescapeName } from "../services/names.js";
import { errorResponse, makeToolResponse } from "./format.js";

export function registerCategoryTools(server: McpServer, engine: ActualEngine, enableWrite: boolean): void {
  server.registerTool(
    "actual_get_categories",
    {
      title: "List Actual Categories",
      description: "List all category groups with their categories, including is_income and hidden flags.",
      inputSchema: {
        include_hidden: z.boolean().default(false).describe("Include hidden groups and categories")
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: { include_hidden: boolean }) => {
      try {
        // The engine's `hidden` option is a filter value, not an include flag:
        // {hidden: true} returns ONLY hidden groups. Omit it to get everything.
        const groups = await engine.read((api) =>
          params.include_hidden ? api.getCategoryGroups() : api.getCategoryGroups({ hidden: false })
        );
        return makeToolResponse({ category_groups: groups });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  if (!enableWrite) return;

  server.registerTool(
    "actual_create_category",
    {
      title: "Create Actual Category",
      description: "Create a category in a group. Unlike the third-party actual-mcp, supports is_income and hidden. Sensitive edit: call only after explicit human authorization.",
      inputSchema: {
        name: z.string().describe("Category name (ampersands are safe; entity-escaped input is unescaped)"),
        group_id: z.string().describe("ID of the category group to create it in"),
        is_income: z.boolean().default(false).describe("Mark as an income category"),
        hidden: z.boolean().default(false).describe("Hide the category")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (params: { name: string; group_id: string; is_income: boolean; hidden: boolean }) => {
      try {
        const request = {
          name: unescapeName(params.name),
          group_id: params.group_id,
          is_income: params.is_income,
          hidden: params.hidden
        };
        const id = await engine.write((api) => api.createCategory(request));
        const backupFile = await writeMutationBackup({
          operation: "actual_create_category",
          before: null,
          request,
          after: { id }
        });
        return makeToolResponse({ backup_file: backupFile, id, ...request });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_create_category_group",
    {
      title: "Create Actual Category Group",
      description: "Create a category group. The engine drops is_income on create, so when is_income is requested this creates the group and immediately updates it (updateCategoryGroup honors the flag). Sensitive edit: call only after explicit human authorization.",
      inputSchema: {
        name: z.string().describe("Group name (ampersands are safe; entity-escaped input is unescaped)"),
        is_income: z.boolean().default(false).describe("Mark as an income group"),
        hidden: z.boolean().default(false).describe("Hide the group")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (params: { name: string; is_income: boolean; hidden: boolean }) => {
      try {
        const request = { name: unescapeName(params.name), is_income: params.is_income, hidden: params.hidden };
        const id = await engine.write(async (api) => {
          const groupId = await api.createCategoryGroup({ name: request.name, hidden: request.hidden });
          if (request.is_income) {
            await api.updateCategoryGroup(groupId, { is_income: true });
          }
          return groupId;
        });
        const backupFile = await writeMutationBackup({
          operation: "actual_create_category_group",
          before: null,
          request,
          after: { id }
        });
        return makeToolResponse({ backup_file: backupFile, id, ...request });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_update_category_group",
    {
      title: "Update Actual Category Group",
      description: "Update a category group's name, is_income, or hidden flag. Sensitive edit: call only after explicit human authorization.",
      inputSchema: {
        id: z.string().describe("Category group ID"),
        name: z.string().optional(),
        is_income: z.boolean().optional(),
        hidden: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: { id: string; name?: string; is_income?: boolean; hidden?: boolean }) => {
      try {
        const fields = {
          ...(params.name !== undefined ? { name: unescapeName(params.name) } : {}),
          ...(params.is_income !== undefined ? { is_income: params.is_income } : {}),
          ...(params.hidden !== undefined ? { hidden: params.hidden } : {})
        };
        if (Object.keys(fields).length === 0) {
          return errorResponse("Provide at least one field to update.");
        }
        await engine.write((api) => api.updateCategoryGroup(params.id, fields));
        const backupFile = await writeMutationBackup({
          operation: "actual_update_category_group",
          request: { id: params.id, fields }
        });
        return makeToolResponse({ backup_file: backupFile, id: params.id, updated: fields });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_delete_category_group",
    {
      title: "Delete Actual Category Group",
      description: "Delete a category group and its categories, optionally moving their transactions to another category. Destructive: call only after explicit human authorization.",
      inputSchema: {
        id: z.string().describe("Category group ID to delete"),
        transfer_category_id: z.string().optional().describe("Category to reassign existing transactions to")
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async (params: { id: string; transfer_category_id?: string }) => {
      try {
        const before = await engine.read(async (api) =>
          (await api.getCategoryGroups()).find((g) => g.id === params.id) ?? null
        );
        await engine.write((api) => api.deleteCategoryGroup(params.id, params.transfer_category_id));
        const backupFile = await writeMutationBackup({
          operation: "actual_delete_category_group",
          before,
          request: params
        });
        return makeToolResponse({ backup_file: backupFile, deleted: params.id });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_update_category",
    {
      title: "Update Actual Category",
      description: "Update a category's name, group, is_income, or hidden flag. Sensitive edit: call only after explicit human authorization.",
      inputSchema: {
        id: z.string().describe("Category ID"),
        name: z.string().optional(),
        group_id: z.string().optional(),
        is_income: z.boolean().optional(),
        hidden: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: { id: string; name?: string; group_id?: string; is_income?: boolean; hidden?: boolean }) => {
      try {
        const fields = {
          ...(params.name !== undefined ? { name: unescapeName(params.name) } : {}),
          ...(params.group_id !== undefined ? { group_id: params.group_id } : {}),
          ...(params.is_income !== undefined ? { is_income: params.is_income } : {}),
          ...(params.hidden !== undefined ? { hidden: params.hidden } : {})
        };
        if (Object.keys(fields).length === 0) {
          return errorResponse("Provide at least one field to update.");
        }
        await engine.write((api) => api.updateCategory(params.id, fields));
        const backupFile = await writeMutationBackup({
          operation: "actual_update_category",
          request: { id: params.id, fields }
        });
        return makeToolResponse({ backup_file: backupFile, id: params.id, updated: fields });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_delete_category",
    {
      title: "Delete Actual Category",
      description: "Delete a category, optionally moving its transactions to another category. Destructive: call only after explicit human authorization.",
      inputSchema: {
        id: z.string().describe("Category ID to delete"),
        transfer_category_id: z.string().optional().describe("Category to reassign existing transactions to")
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async (params: { id: string; transfer_category_id?: string }) => {
      try {
        const before = await engine.read(async (api) =>
          (await api.getCategories()).find((c) => c.id === params.id) ?? null
        );
        await engine.write((api) => api.deleteCategory(params.id, params.transfer_category_id));
        const backupFile = await writeMutationBackup({
          operation: "actual_delete_category",
          before,
          request: params
        });
        return makeToolResponse({ backup_file: backupFile, deleted: params.id });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );
}
