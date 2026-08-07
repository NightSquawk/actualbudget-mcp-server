import * as api from "@actual-app/api";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { ActualConfig } from "../types.js";
import { Mutex } from "./mutex.js";

type EngineState = "stopped" | "starting" | "ready" | "stopping";

/**
 * Long-lived wrapper around @actual-app/api.
 *
 * The API is not a REST client: init() + downloadBudget() pull the whole
 * budget into a local sqlite file and every method runs against that copy,
 * with sync() pushing CRDT messages back to the server. That makes it a
 * stateful per-process singleton:
 *
 * - init once at startup, shutdown once at exit (never per tool call)
 * - writes serialized through a mutex
 * - reload() recovers from a server-side budget reset by deleting the local
 *   cache and re-downloading, since downloadBudget() short-circuits to
 *   load-local + incremental sync whenever a cached copy exists
 */
export class ActualEngine {
  private state: EngineState = "stopped";
  private readonly lifecycle = new Mutex();
  private readonly writes = new Mutex();

  constructor(private readonly config: ActualConfig) {}

  get ready(): boolean {
    return this.state === "ready";
  }

  async start(): Promise<void> {
    return this.lifecycle.run(async () => {
      if (this.state === "ready") return;
      await mkdir(this.config.dataDir, { recursive: true });
      await this.boot();
      try {
        await api.getBudgetMonths();
      } catch {
        // A local cache dir whose metadata matches the sync id makes
        // downloadBudget() short-circuit to load-local even when that copy is
        // broken or stale (e.g. renamed/reset caches). Self-heal: move the
        // stale dirs aside and download fresh.
        console.error("actual engine: budget loaded but is not readable; purging stale local cache and re-downloading");
        await api.shutdown().catch(() => undefined);
        await this.quarantineLocalCaches();
        await this.boot();
        await api.getBudgetMonths();
      }
      this.state = "ready";
    });
  }

  private async boot(): Promise<void> {
    this.state = "starting";
    await api.init({
      dataDir: this.config.dataDir,
      serverURL: this.config.serverUrl,
      password: this.config.password
    });
    await api.downloadBudget(
      this.config.budgetSyncId,
      this.config.budgetEncryptionPassword
        ? { password: this.config.budgetEncryptionPassword }
        : undefined
    );
  }

  /**
   * Move every top-level cache dir whose metadata matches our sync id into
   * .stale/ instead of deleting it: getBudgets() only scans top-level dirs,
   * so this hides them from the load-local short-circuit while preserving
   * manual backups (e.g. *.bak-* dirs an operator renamed by hand).
   */
  private async quarantineLocalCaches(): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const staleRoot = join(this.config.dataDir, ".stale");
    const entries = await readdir(this.config.dataDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".stale") continue;
      const dir = join(this.config.dataDir, entry.name);
      try {
        const meta = JSON.parse(await readFile(join(dir, "metadata.json"), "utf8")) as Record<string, unknown>;
        if (meta.groupId === this.config.budgetSyncId || meta.cloudFileId === this.config.budgetSyncId) {
          await mkdir(staleRoot, { recursive: true });
          await rename(dir, join(staleRoot, `${entry.name}-${stamp}`));
          console.error(`actual engine: quarantined stale cache ${entry.name} -> .stale/`);
        }
      } catch {
        // not a budget cache dir; leave it alone
      }
    }
  }

  /** Reads run concurrently; the engine's own handler queue is enough. */
  async read<T>(fn: (a: typeof api) => Promise<T>): Promise<T> {
    this.assertReady();
    return fn(api);
  }

  /** Writes are serialized so bulk operations cannot race each other. */
  async write<T>(fn: (a: typeof api) => Promise<T>): Promise<T> {
    this.assertReady();
    return this.writes.run(() => fn(api));
  }

  /** Push local changes to the sync server without restarting anything. */
  async syncNow(): Promise<void> {
    this.assertReady();
    return this.writes.run(() => api.sync());
  }

  /**
   * Full recovery from a stale local cache (e.g. after resetting the budget
   * cache or re-uploading the file in the Actual UI): shut down, delete the
   * cached budget directory, re-init, re-download.
   */
  async reload(): Promise<void> {
    return this.lifecycle.run(() =>
      this.writes.run(async () => {
        if (this.state === "ready") {
          this.state = "stopping";
          await api.shutdown().catch(() => undefined);
          this.state = "stopped";
        }
        await this.quarantineLocalCaches();
        await this.boot();
        await api.getBudgetMonths();
        this.state = "ready";
      })
    );
  }

  /** Flush sync and release the sqlite file. Must run before process exit. */
  async stop(): Promise<void> {
    return this.lifecycle.run(() =>
      this.writes.run(async () => {
        if (this.state !== "ready") return;
        this.state = "stopping";
        await api.shutdown();
        this.state = "stopped";
      })
    );
  }

  private assertReady(): void {
    if (this.state !== "ready") {
      throw new Error(
        `Actual engine is ${this.state}. If the budget failed to load, try the actual_reload_budget tool; otherwise restart the MCP server.`
      );
    }
  }
}
