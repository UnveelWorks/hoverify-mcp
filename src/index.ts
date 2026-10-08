#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Bridge, VERSION } from "./bridge.js";
import { DEFAULT_PORT, MISSING_TOKEN } from "./protocol.js";
import { registerTools } from "./tools.js";

// stdout carries the MCP protocol, so every log line goes to stderr
const log = (line: string) => process.stderr.write(`[hoverify-mcp] ${line}\n`);

const token = process.env.HOVERIFY_TOKEN || "";
if (!token)
{
    log(MISSING_TOKEN);
}

const bridge = new Bridge({
    port: Number(process.env.HOVERIFY_MCP_PORT) || DEFAULT_PORT,
    token,
    name: `${process.pid}`,
    log,
});

const server = new McpServer({ name: "hoverify", version: VERSION });
registerTools(server, bridge);

bridge.start();
await server.connect(new StdioServerTransport());

const shutdown = () =>
{
    bridge.close();
    process.exit(0);
};
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
