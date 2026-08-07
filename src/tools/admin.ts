import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ActualEngine } from "../services/engine.js";
import { formatActualError } from "../services/errors.js";
import { errorResponse, makeToolResponse } from "./format.js";

export function registerAdminTools(server: McpServer, engine: ActualEngine): void {
  server.registerTool(
    "actual_sync_now",
    {
      title: "Sync Actual Budget",
      description: "Push pending local changes to the sync server and pull remote changes. Cheap; use after a batch of writes or when another device may have changed the budget.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async () => {
      try {
        await engine.syncNow();
        return makeToolResponse({ synced: true });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_reload_budget",
    {
      title: "Reload Actual Budget",
      description: "Recover from a stale local cache: shut the engine down, delete the cached budget directory, re-initialize, and re-download the budget from the sync server. Use when tools fail with 'unknown problem opening' or 'No budget file is open' — typically after the budget cache was reset or the file re-uploaded in the Actual UI. Local changes not yet synced are lost.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
    },
    async () => {
      try {
        await engine.reload();
        return makeToolResponse({ reloaded: true });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_get_server_version",
    {
      title: "Get Actual Server Version",
      description: "Report the version of the connected actual-server instance. Also a cheap health check for the engine connection.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async () => {
      try {
        const version = await engine.read((api) => api.getServerVersion());
        return makeToolResponse({ ...version });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );
}
