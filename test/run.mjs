// Real MCP clients (each spawning the built server) against a fake extension on the WebSocket side.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = 47999;
const TOKEN = "test-token-0123456789abcdef";
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failed = 0;
const check = (name, condition, detail = "") =>
{
    console.log(`  ${name.padEnd(56)} ${condition ? "ok" : `FAILED ${detail}`}`);
    if (!condition) failed++;
};

async function agent(name, token = TOKEN)
{
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(ROOT, "dist/index.js")],
        env: { ...process.env, HOVERIFY_TOKEN: token, HOVERIFY_MCP_PORT: String(PORT) },
        stderr: "pipe",
    });
    const client = new Client({ name: `test-${name}`, version: "0" });
    await client.connect(transport);
    const call = async (tool, args = {}) => client.callTool({ name: tool, arguments: args });
    return { client, transport, call };
}

function fakeExtension({ origin = "chrome-extension://abcdefgh", token = TOKEN, protocol = 1 } = {})
{
    const events = { welcome: null, closed: null, calls: [] };
    let socket;
    const connect = () => new Promise(resolve =>
    {
        socket = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: origin ? { origin } : {} });
        socket.on("open", () => socket.send(JSON.stringify({ type: "hello", role: "ext", token, protocol, browser: "Chrome 131", extension_version: "9.9.9" })));
        socket.on("message", async raw =>
        {
            const message = JSON.parse(String(raw));
            if (message.type === "welcome") { events.welcome = message; resolve(true); }
            if (message.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
            if (message.type !== "call") return;
            events.calls.push(message);
            const delay = message.args.delay_ms || (String(message.args.url || "").includes("/slow") ? 1500 : 0);
            if (delay) await sleep(delay);
            const output = message.tool === "capture"
                ? { content: [{ type: "text", text: "Screenshot of http://example.test/" }], files: [{ name: "capture-test.png", data: Buffer.from("png-bytes").toString("base64") }] }
                : { content: [{ type: "text", text: JSON.stringify({ tool: message.tool, args: message.args }) }] };
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "result", id: message.id, ok: true, output }));
        });
        socket.on("close", (code, reason) => { events.closed = { code, reason: String(reason) }; resolve(false); });
        socket.on("error", () => resolve(false));
    });
    return { events, connect, close: () => socket?.close() };
}

const text = result => result.content?.[0]?.text || "";
const portFree = () => new Promise(resolve =>
{
    const probe = new WebSocket(`ws://127.0.0.1:${PORT}`);
    probe.on("open", () => { probe.close(); resolve(false); });
    probe.on("error", () => resolve(true));
});

const tokenless = await agent("tokenless", "");
const asked = Date.now();
const missing = await tokenless.call("get_status");
check("no token: a clear error at once", missing.isError && /HOVERIFY_TOKEN isn't set/.test(text(missing)) && Date.now() - asked < 1000, text(missing));
check("no token: the port is left for sessions that have one", await portFree());
await tokenless.client.close();

const A = await agent("A");
const tools = await A.client.listTools();
check("lists the ten tools", tools.tools.length === 10, tools.tools.map(t => t.name).join(","));

const started = Date.now();
const lonely = await A.call("get_status");
check("no browser: clear error after the wait", lonely.isError && /Connect to agent/.test(text(lonely)) && Date.now() - started < 8000, text(lonely));

const web = fakeExtension({ origin: "https://evil.example" });
await web.connect();
check("a web page origin is refused", web.events.closed?.code === 1008, JSON.stringify(web.events.closed));

const wrong = fakeExtension({ token: "nope" });
await wrong.connect();
check("a wrong token is refused", wrong.events.closed?.code === 1008, JSON.stringify(wrong.events.closed));

const noOrigin = fakeExtension({ origin: null });
await noOrigin.connect();
check("an extension hello without an extension origin is refused", noOrigin.events.closed?.code === 1008, JSON.stringify(noOrigin.events.closed));

const old = fakeExtension({ protocol: 0 });
await old.connect();
await sleep(100);
check("a protocol mismatch is refused with a reason", old.events.closed?.code === 1008 && /protocol/.test(old.events.closed.reason), JSON.stringify(old.events.closed));

let ext = fakeExtension();
check("the extension connects with the right token", await ext.connect() && ext.events.welcome?.protocol === 1);

const status = await A.call("audit_seo", { format: "json" });
check("a call reaches the extension with its arguments", JSON.parse(text(status)).args.format === "json", text(status));

const B = await agent("B");
const relayed = await B.call("inspect_element", { selector: "#card" });
check("a second agent session relays through the hub", JSON.parse(text(relayed)).args.selector === "#card", text(relayed));

const C = await agent("C", "other-token");
const refused = await C.call("get_status");
check("a session with another token gets a clear error", refused.isError && /different HOVERIFY_TOKEN/.test(text(refused)), text(refused));
await C.client.close();
const unaffected = await B.call("get_status");
check("and the other sessions keep working", !unaffected.isError, text(unaffected));

const shot = await B.call("capture", { mode: "viewport" });
const saved = shot.content.find(c => /Full-resolution PNG: /.test(c.text || ""));
const path = saved?.text.replace("Full-resolution PNG: ", "");
check("capture files are written to disk and their path returned", path && existsSync(path) && readFileSync(path, "utf8") === "png-bytes", JSON.stringify(shot.content));

// the hub exits mid-call: the idempotent call is retried once the extension reconnects to the new hub
const inflight = B.call("audit_accessibility", { delay_ms: 1500 });
await sleep(300);
await A.client.close();
await sleep(400);
ext = fakeExtension();
for (let i = 0; i < 20 && !(await ext.connect()); i++) await sleep(200);
const retried = await inflight;
check("an idempotent call survives the hub exiting", !retried.isError && JSON.parse(text(retried)).tool === "audit_accessibility", text(retried));

const opened = B.call("open_url", { url: "http://localhost:3000/slow" });
await sleep(300);
ext.close();
const dropped = await opened;
check("a call with side effects is not retried after a drop", dropped.isError && /dropped/.test(text(dropped)), text(dropped));

await B.client.close();
await sleep(300);

// the agent kept an old token after a new one was made in the popup
const stale = await agent("stale", "stale-token");
const current = fakeExtension();
for (let i = 0; i < 20 && current.events.closed?.code !== 1008; i++) { await current.connect(); await sleep(100); }
const staleAsked = Date.now();
const mismatch = await stale.call("get_status");
check("a stale token says so instead of not connected", mismatch.isError && /different token/.test(text(mismatch)) && Date.now() - staleAsked < 1000, text(mismatch));
await stale.client.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
