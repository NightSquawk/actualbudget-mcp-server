import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ActualEngine } from "../services/engine.js";
import { registerAccountTools } from "./accounts.js";
import { registerAdminTools } from "./admin.js";
import { registerBudgetTools } from "./budget.js";
import { registerCategoryTools } from "./categories.js";
import { registerTransactionTools } from "./transactions.js";

export function registerTools(server: McpServer, engine: ActualEngine, enableWrite: boolean): void {
  registerAdminTools(server, engine);
  registerAccountTools(server, engine, enableWrite);
  registerCategoryTools(server, engine, enableWrite);
  registerBudgetTools(server, engine, enableWrite);
  registerTransactionTools(server, engine);
}
