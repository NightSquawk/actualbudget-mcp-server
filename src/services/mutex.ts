/**
 * Promise-chain mutex. The Actual engine is a per-process singleton over a
 * better-sqlite3 file; concurrent lifecycle operations (init/shutdown) and
 * writes racing each other is exactly the failure mode that poisons the
 * budget cache. Everything that mutates engine state runs through this.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
