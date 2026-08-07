#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { loadConfig } from "./services/config.js";
import { ActualEngine } from "./services/engine.js";
import { registerTools } from "./tools/index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const engine = new ActualEngine(config);
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION
  });

  registerTools(server, engine, config);

  // api.shutdown() must run before exit: it flushes pending sync messages and
  // releases the sqlite file. Cover signals and the client closing the pipe.
  let shuttingDown = false;
  const shutdown = async (reason: string, code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`${SERVER_NAME}: shutting down (${reason})`);
    try {
      await engine.stop();
    } catch (error) {
      console.error(`${SERVER_NAME}: shutdown error: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(code);
  };

  process.on("SIGINT", () => void shutdown("SIGINT", 0));
  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.stdin.on("close", () => void shutdown("stdin closed", 0));

  // Block startup on the initial download so tools never see a half-ready
  // engine. Slow first boot (seconds) is the accepted trade-off.
  console.error(`${SERVER_NAME}: connecting to ${config.serverUrl} and downloading budget...`);
  await engine.start();
  console.error(`${SERVER_NAME}: budget ready`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `${SERVER_NAME} ${SERVER_VERSION} running on stdio (writes ${config.enableWrite ? "ENABLED" : "disabled"})`
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
