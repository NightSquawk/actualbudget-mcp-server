export type ActualConfig = {
  serverUrl: string;
  password: string;
  budgetSyncId: string;
  dataDir: string;
  budgetEncryptionPassword?: string;
  enableWrite: boolean;
};

export type ToolResponse<T> = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: T;
  isError?: boolean;
};
