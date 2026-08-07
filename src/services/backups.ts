import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type BackupRecord = {
  operation: string;
  before?: unknown;
  request?: unknown;
  after?: unknown;
};

export async function writeMutationBackup(record: BackupRecord): Promise<string> {
  const directory = join(tmpdir(), "actual-mcp-backups");
  await mkdir(directory, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeOperation = record.operation.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
  const fullPath = join(directory, `${stamp}-${safeOperation}.json`);

  await writeFile(
    fullPath,
    JSON.stringify({ created_at: new Date().toISOString(), ...record }, null, 2),
    "utf8"
  );

  return fullPath;
}
