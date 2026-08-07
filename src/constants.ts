export const SERVER_NAME = "actual-mcp-server";
export const SERVER_VERSION = "0.1.0";

export const ENV = {
  serverUrl: "ACTUAL_SERVER_URL",
  password: "ACTUAL_PASSWORD",
  budgetSyncId: "ACTUAL_BUDGET_SYNC_ID",
  dataDir: "ACTUAL_DATA_DIR",
  budgetEncryptionPassword: "ACTUAL_BUDGET_ENCRYPTION_PASSWORD",
  enableWrite: "ACTUAL_ENABLE_WRITE"
} as const;

export const RESPONSE_CHARACTER_LIMIT = 25_000;
