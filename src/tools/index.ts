import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ActualEngine } from "../services/engine.js";
import type { ActualConfig } from "../types.js";
import { registerAccountTools } from "./accounts.js";
import { registerAdminTools } from "./admin.js";
import { registerBudgetTools } from "./budget.js";
import { registerCategoryTools } from "./categories.js";
import { registerPayeeTools } from "./payees.js";
import { registerRuleTools } from "./rules.js";
import { registerScheduleTools } from "./schedules.js";
import { registerTagTools } from "./tags.js";
import { registerTransactionTools } from "./transactions.js";

export function registerTools(server: McpServer, engine: ActualEngine, config: ActualConfig): void {
  registerAdminTools(server, engine, config);
  registerAccountTools(server, engine, config.enableWrite);
  registerCategoryTools(server, engine, config.enableWrite);
  registerBudgetTools(server, engine, config.enableWrite);
  registerTransactionTools(server, engine, config.enableWrite);
  registerPayeeTools(server, engine, config.enableWrite);
  registerRuleTools(server, engine, config.enableWrite);
  registerScheduleTools(server, engine, config.enableWrite);
  registerTagTools(server, engine, config.enableWrite);
}
