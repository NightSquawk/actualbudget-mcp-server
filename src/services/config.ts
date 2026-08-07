import "dotenv/config";
import { resolve } from "node:path";
import { ENV } from "../constants.js";
import type { ActualConfig } from "../types.js";

export function loadConfig(): ActualConfig {
  const serverUrl = process.env[ENV.serverUrl]?.trim();
  const password = process.env[ENV.password]?.trim();
  const budgetSyncId = process.env[ENV.budgetSyncId]?.trim();
  const dataDir = process.env[ENV.dataDir]?.trim();
  const budgetEncryptionPassword = process.env[ENV.budgetEncryptionPassword]?.trim();

  if (!serverUrl) {
    throw new Error(`${ENV.serverUrl} is required, for example https://actual.example.com`);
  }

  if (!password) {
    throw new Error(`${ENV.password} is required. This is the password you use to log into the Actual web UI.`);
  }

  if (!budgetSyncId) {
    throw new Error(`${ENV.budgetSyncId} is required. Find it in Actual under Settings -> Show advanced settings -> Sync ID.`);
  }

  if (!dataDir) {
    throw new Error(`${ENV.dataDir} is required. It is where the budget file is cached locally, for example ./.actual-data`);
  }

  return {
    serverUrl: serverUrl.replace(/\/+$/, ""),
    password,
    budgetSyncId,
    dataDir: resolve(dataDir),
    ...(budgetEncryptionPassword ? { budgetEncryptionPassword } : {}),
    enableWrite: process.env[ENV.enableWrite]?.trim() === "true"
  };
}
