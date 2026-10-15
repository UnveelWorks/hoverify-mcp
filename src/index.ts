#!/usr/bin/env node
import { fileURLToPath } from "node:url";
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

function configuredBrowser(): string
{
    const at = process.argv.findIndex(arg => arg === "--browser" || arg.startsWith("--browser="));
    if (at < 0) return (process.env.HOVERIFY_BROWSER || "").trim();
    const arg = process.argv[at];
    return (arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : process.argv[at + 1] || "").trim();
}

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
    configured: configuredBrowser(),
    log,
});
server.server.oninitialized = async () =>
{
    bridge.agentChanged();
    if (!server.server.getClientCapabilities()?.roots) return;
    try
    {
        const { roots } = await server.server.listRoots();
        const first = roots.find(root => root.uri.startsWith("file:"));
        if (first) bridge.setProject(fileURLToPath(first.uri));
    }
    catch (error)
    {
        log(`couldn't read the agent's project folder: ${(error as Error).message}`);
    }
};
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
