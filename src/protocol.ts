export const PROTOCOL = 2;
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
    protocol: number;
    nonce: string;
    browser: string;
    extension_version: string;
}

export interface PeerHello
{
    type: "hello";
    role: "peer";
    protocol: number;
    nonce: string;
    agent: string;
}

// proof is HMAC(key, "hub|<client nonce>|<hub nonce>"); the client answers with auth, HMAC(key, "client|<hub nonce>|<client nonce>")
export interface Challenge
{
    type: "challenge";
    nonce: string;
    key_id: string;
    proof: string;
    agents: string[];
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
export const APPROVAL_NEEDED = "Hoverify is asking whether to let this agent connect. Click the Hoverify icon in the browser and choose Allow, then try again.";
export const PEER_REJECTED = "Another agent session holds the connection to Hoverify and uses a different key file. That happens when agents run with different home folders. Set HOVERIFY_HOME to the same folder for every agent, then restart them.";
export const PEER_VERSION = "Another agent session holds the connection to Hoverify and runs a different version of hoverify-mcp. Restart your agent sessions so they all run the same version.";
export const EXTENSION_VERSION = "Hoverify and hoverify-mcp are different versions and can't connect. Update the Hoverify extension, and restart the agent so it runs the latest hoverify-mcp.";
export const BRIDGE_RESET = "bridge_reset";
