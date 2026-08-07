import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ActualEngine } from "../services/engine.js";
import { writeMutationBackup } from "../services/backups.js";
import { formatActualError } from "../services/errors.js";
import type { ActualConfig } from "../types.js";
import { errorResponse, makeToolResponse } from "./format.js";

export function registerAdminTools(server: McpServer, engine: ActualEngine, config: ActualConfig): void {
  server.registerTool(
    "actual_query",
    {
      title: "Run Actual AQL Query",
      description: "Run a read-only AQL query against any table (transactions, accounts, categories, category_groups, payees, schedules, rules, notes). Supports filter operators ($eq, $ne, $lt, $lte, $gt, $gte, $like, $oneof, $and, $or), dotted joins in select/filter ('payee.name', 'category.name'), groupBy, orderBy, limit/offset, and aggregate calculate expressions like {\"$sum\": \"$amount\"} or {\"$count\": \"*\"}. Example — spending by category for a month: table 'transactions', filter {date: {$gte: '2026-08-01', $lte: '2026-08-31'}, amount: {$lt: 0}}, groupBy 'category.name', select [{category: 'category.name'}, {total: {$sum: '$amount'}}]. Amounts are minor units (cents).",
      inputSchema: {
        table: z.string().describe("Table name, e.g. 'transactions'"),
        filter: z.record(z.unknown()).optional(),
        select: z.array(z.unknown()).optional().describe("Fields or {alias: expr} objects; defaults to '*'"),
        group_by: z.union([z.string(), z.array(z.string())]).optional(),
        order_by: z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())]).optional().describe("e.g. {date: 'desc'}"),
        calculate: z.record(z.unknown()).optional().describe("Single aggregate instead of select, e.g. {$sum: '$amount'}"),
        limit: z.number().int().min(1).max(5000).optional(),
        offset: z.number().int().min(0).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: {
      table: string;
      filter?: Record<string, unknown>;
      select?: unknown[];
      group_by?: string | string[];
      order_by?: unknown;
      calculate?: Record<string, unknown>;
      limit?: number;
      offset?: number;
    }) => {
      try {
        const result = await engine.read(async (api) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let query: any = api.q(params.table as never);
          if (params.table === "transactions") query = query.options({ splits: "inline" });
          if (params.filter) query = query.filter(params.filter);
          if (params.group_by) query = query.groupBy(params.group_by);
          if (params.order_by) query = query.orderBy(params.order_by);
          if (params.calculate) query = query.calculate(params.calculate);
          else query = query.select(params.select ?? "*");
          if (params.limit !== undefined) query = query.limit(params.limit);
          if (params.offset !== undefined) query = query.offset(params.offset);
          return (await api.aqlQuery(query)) as { data: unknown };
        });
        return makeToolResponse({ data: result.data });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  server.registerTool(
    "actual_get_note",
    {
      title: "Get Actual Note",
      description: "Get the note attached to an entity (account, category, category group, schedule) by that entity's ID.",
      inputSchema: { id: z.string().describe("Entity ID the note is attached to") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: { id: string }) => {
      try {
        const note = await engine.read((api) => api.getNote(params.id));
        return makeToolResponse({ note });
      } catch (error) {
        return errorResponse(formatActualError(error));
      }
    }
  );

  if (config.enableWrite) {
    server.registerTool(
      "actual_update_note",
      {
        title: "Update Actual Note",
        description: "Set or replace the note attached to an entity (account, category, category group, schedule) by that entity's ID. Sensitive edit: call only after explicit human authorization.",
        inputSchema: {
          id: z.string().describe("Entity ID the note attaches to"),
          note: z.string().describe("Note text; empty string clears it")
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async (params: { id: string; note: string }) => {
        try {
          const before = await engine.read((api) => api.getNote(params.id));
          await engine.write((api) => api.updateNote(params.id, params.note));
          const backupFile = await writeMutationBackup({ operation: "actual_update_note", before, request: params });
          return makeToolResponse({ backup_file: backupFile, id: params.id, note: params.note });
        } catch (error) {
          return errorResponse(formatActualError(error));
        }
      }
    );

    server.registerTool(
      "actual_run_bank_sync",
      {
        title: "Run Actual Bank Sync",
        description: "Trigger bank sync (GoCardless/SimpleFIN) for one account or all linked accounts, pulling new transactions from the bank provider. Slow (external providers). Sensitive: call only after explicit human authorization.",
        inputSchema: {
          account_id: z.string().optional().describe("Sync only this account; omit for all linked accounts")
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async (params: { account_id?: string }) => {
        try {
          await engine.write((api) =>
            params.account_id ? api.runBankSync({ accountId: params.account_id }) : api.runBankSync()
          );
          return makeToolResponse({ synced: true, scope: params.account_id ?? "all" });
        } catch (error) {
          return errorResponse(formatActualError(error));
        }
      }
    );
  }
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
    "actual_prune_stale",
    {
      title: "Prune Quarantined Budget Caches",
      description: "List or delete quarantined stale budget caches under ACTUAL_DATA_DIR/.stale/ (created by self-heal and actual_reload_budget; ~2-3 MB each). With dry_run=true (default) only reports what would be deleted. Destructive when dry_run=false: call only after explicit human authorization.",
      inputSchema: {
        older_than_days: z.number().int().min(0).default(0).describe("Only prune entries older than this many days; 0 = all"),
        dry_run: z.boolean().default(true).describe("true = report only, false = actually delete")
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async (params: { older_than_days: number; dry_run: boolean }) => {
      try {
        const staleRoot = join(config.dataDir, ".stale");
        const entries = await readdir(staleRoot).catch(() => [] as string[]);
        const cutoff = Date.now() - params.older_than_days * 86_400_000;
        const candidates: Array<{ name: string; modified: string; size_bytes: number }> = [];

        for (const name of entries) {
          const path = join(staleRoot, name);
          const info = await stat(path);
          if (info.mtimeMs > cutoff) continue;
          let size = 0;
          for (const file of await readdir(path).catch(() => [] as string[])) {
            size += (await stat(join(path, file)).catch(() => ({ size: 0 }))).size;
          }
          candidates.push({ name, modified: info.mtime.toISOString(), size_bytes: size });
          if (!params.dry_run) {
            await rm(path, { recursive: true, force: true });
          }
        }

        return makeToolResponse({
          stale_dir: staleRoot,
          dry_run: params.dry_run,
          [params.dry_run ? "would_delete" : "deleted"]: candidates,
          total_bytes: candidates.reduce((sum, c) => sum + c.size_bytes, 0)
        });
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
