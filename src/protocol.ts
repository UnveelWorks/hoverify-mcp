export const PROTOCOL = 1;
export const DEFAULT_PORT = 47862;
export const PING_INTERVAL = 20_000;

export interface TextContent
{
    type: "text";
    text: string;
}

export interface ImageContent
{
    type: "image";
    data: string;
    mimeType: string;
}

export type Content = TextContent | ImageContent;

// files carry full-resolution captures; the server writes them to disk and returns the path
export interface ToolOutput
{
    content: Content[];
    files?: { name: string, data: string }[];
}

export interface ExtensionHello
{
    type: "hello";
    role: "ext";
    token: string;
    protocol: number;
    browser: string;
    extension_version: string;
}

export interface PeerHello
{
    type: "hello";
    role: "peer";
    token: string;
    protocol: number;
}

export interface CallMessage
{
    type: "call";
    id: string;
    tool: string;
    args: Record<string, unknown>;
}

export interface ResultMessage
{
    type: "result";
    id: string;
    ok: boolean;
    output?: ToolOutput;
    error?: string;
}

export const NOT_CONNECTED = "Hoverify isn't connected. Open the Hoverify popup in Chrome or Firefox and switch on Connect to agent, then try again.";
export const MISSING_TOKEN = "HOVERIFY_TOKEN isn't set. Copy the agent setup from the AI agent page in the Hoverify popup into this agent's MCP config, then restart the agent.";
export const TOKEN_MISMATCH = "Hoverify is trying to connect with a different token than this agent's HOVERIFY_TOKEN. Copy the agent setup from the AI agent page in the Hoverify popup into this agent's MCP config, then restart the agent.";
export const PEER_REJECTED = "Another agent session is running hoverify-mcp with a different HOVERIFY_TOKEN and holds the connection to Hoverify. Copy the agent setup from the AI agent page in the Hoverify popup into every agent's MCP config, then restart them.";
export const BRIDGE_RESET = "bridge_reset";
