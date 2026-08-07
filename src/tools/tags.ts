import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ActualEngine } from "../services/engine.js";
import { formatActualError } from "../services/errors.js";
import { writeMutationBackup } from "../services/backups.js";
import { errorResponse, makeToolResponse } from "./format.js";

export function registerTagTools(server: McpServer, engine: ActualEngine, enableWrite: boolean): void {
  server.registerTool(
    "actual_get_tags",
    {
      title: "List Actual Tags",
      description: "List all note tags (#tag) with color and description.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      try {
        const tags = await engine.read((api) => api.getTags());
        return makeToolResponse({ tags });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  if (!enableWrite) return;

  server.registerTool(
    "actual_create_tag",
    {
      title: "Create Actual Tag",
      description: "Create a note tag. Sensitive edit: call only after explicit human authorization.",
      inputSchema: {
        tag: z.string().describe("Tag text without the leading #"),
        color: z.string().optional().describe("Hex color like #ff8800"),
        description: z.string().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (params: { tag: string; color?: string; description?: string }) => {
      try {
        const request = {
          tag: params.tag,
          color: params.color ?? null,
          description: params.description ?? null
        };
        const id = await engine.write((api) => api.createTag(request));
        const backupFile = await writeMutationBackup({ operation: "actual_create_tag", before: null, request, after: { id } });
        return makeToolResponse({ backup_file: backupFile, id, ...params });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_update_tag",
    {
      title: "Update Actual Tag",
      description: "Update a tag's text, color, or description. Sensitive edit: call only after explicit human authorization.",
      inputSchema: {
        id: z.string().describe("Tag ID"),
        tag: z.string().optional(),
        color: z.string().nullable().optional(),
        description: z.string().nullable().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: { id: string; tag?: string; color?: string | null; description?: string | null }) => {
      try {
        const fields = {
          ...(params.tag !== undefined ? { tag: params.tag } : {}),
          ...(params.color !== undefined ? { color: params.color } : {}),
          ...(params.description !== undefined ? { description: params.description } : {})
        };
        if (Object.keys(fields).length === 0) {
          return errorResponse("Provide at least one field to update.");
        }
        const before = await engine.read(async (api) => (await api.getTags()).find((t) => t.id === params.id) ?? null);
        await engine.write((api) => api.updateTag(params.id, fields));
        const backupFile = await writeMutationBackup({ operation: "actual_update_tag", before, request: { id: params.id, fields } });
        return makeToolResponse({ backup_file: backupFile, id: params.id, updated: fields });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_delete_tag",
    {
      title: "Delete Actual Tag",
      description: "Delete a tag. Destructive: call only after explicit human authorization.",
      inputSchema: { id: z.string().describe("Tag ID to delete") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async (params: { id: string }) => {
      try {
        const before = await engine.read(async (api) => (await api.getTags()).find((t) => t.id === params.id) ?? null);
        await engine.write((api) => api.deleteTag(params.id));
        const backupFile = await writeMutationBackup({ operation: "actual_delete_tag", before, request: params });
        return makeToolResponse({ backup_file: backupFile, deleted: params.id });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );
}
