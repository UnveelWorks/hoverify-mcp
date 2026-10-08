#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Bridge, VERSION } from "./bridge.js";
import { DEFAULT_PORT, RELEASE_AFTER } from "./protocol.js";
import { registerTools } from "./tools.js";

// stdout carries the MCP protocol, so every log line goes to stderr
const log = (line: string) => process.stderr.write(`[hoverify-mcp] ${line}\n`);

// shown in Hoverify's "allow this agent?" prompt
const AGENT_NAMES: Record<string, string> = {
    "claude-code": "Claude Code",
    "claude-ai": "Claude Desktop",
    "cursor-vscode": "Cursor",
    "Visual Studio Code": "VS Code",
};

const server = new McpServer({ name: "hoverify", version: VERSION });

const bridge = new Bridge({
    port: Number(process.env.HOVERIFY_MCP_PORT) || DEFAULT_PORT,
    name: `${process.pid}`,
    releaseAfter: Number(process.env.HOVERIFY_MCP_IDLE_MS) || RELEASE_AFTER,
    agent: () =>
    {
        const client = server.server.getClientVersion();
        return client ? AGENT_NAMES[client.name] || client.title || client.name : "";
    },
    log,
});
server.server.oninitialized = () => bridge.agentChanged();
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
