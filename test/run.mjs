// Real MCP clients (each spawning the built server) against a fake extension on the WebSocket side.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket, WebSocketServer } from "ws";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = 47999;
const CROWD_PORT = 47997;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const home = () => mkdtempSync(join(tmpdir(), "hoverify-mcp-test-"));
const HOME = home();
const keyFile = dir => join(dir, "agent.key");
const prove = (key, ...parts) => createHmac("sha256", Buffer.from(key, "hex")).update(parts.join("|")).digest("hex");
const keyIdOf = key => createHash("sha256").update(Buffer.from(key, "hex")).digest("hex").slice(0, 16);
const nonce = () => randomBytes(16).toString("hex");

let failed = 0;
const check = (name, condition, detail = "") =>
{
    console.log(`  ${name.padEnd(56)} ${condition ? "ok" : `FAILED ${detail}`}`);
    if (!condition) failed++;
};

async function agent(name, { dir = HOME, port = PORT } = {})
{
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(ROOT, "dist/index.js")],
        env: { ...process.env, HOVERIFY_HOME: dir, HOVERIFY_MCP_PORT: String(port) },
        stderr: "pipe",
    });
    const client = new Client({ name: `test-${name}`, version: "0" });
    await client.connect(transport);
    const call = async (tool, args = {}) => client.callTool({ name: tool, arguments: args });
    return { client, transport, call };
}

// key: the key it was allowed with before, or null for a browser that hasn't paired; allow: whether the user says yes at once
function fakeExtension({ origin = "chrome-extension://abcdefgh", key = null, protocol = 2, allow = true, badProof = false, port = PORT } = {})
{
    const events = { challenge: null, welcome: null, closed: null, approval: false, key: null, agents: [], calls: [] };
    let socket;
    let mine;
    const auth = (k, challenge) => socket.send(JSON.stringify({ type: "auth", proof: badProof ? "0".repeat(64) : prove(k, "client", challenge.nonce, mine) }));
    const connect = () => new Promise(resolve =>
    {
        mine = nonce();
        Object.assign(events, { challenge: null, welcome: null, closed: null, approval: false });
        socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers: origin ? { origin } : {} });
        socket.on("open", () => socket.send(JSON.stringify({ type: "hello", role: "ext", protocol, nonce: mine, browser: "Chrome 131", extension_version: "9.9.9" })));
        socket.on("message", async raw =>
        {
            const message = JSON.parse(String(raw));
            if (message.type === "challenge")
            {
                events.challenge = message;
                if (key && message.key_id === keyIdOf(key) && message.proof === prove(key, "hub", mine, message.nonce)) return auth(key, message);
                events.approval = true;
                socket.send(JSON.stringify({ type: "approval" }));
                if (allow) socket.send(JSON.stringify({ type: "pair" }));
                else resolve("approval");
            }
            if (message.type === "key")
            {
                events.key = message.key;
                key = message.key;
                auth(key, events.challenge);
            }
            if (message.type === "welcome") { events.welcome = message; events.agents = message.agents || []; resolve(message.error ? "refused" : "welcome"); }
            if (message.type === "agents") events.agents = message.agents;
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
        socket.on("close", (code, reason) => { events.closed = { code, reason: String(reason) }; resolve("closed"); });
        socket.on("error", () => resolve("closed"));
    });
    return { events, connect, allow: () => socket.send(JSON.stringify({ type: "pair" })), close: () => socket?.close(), get key() { return key; } };
}

const text = result => result.content?.[0]?.text || "";
const portFree = (port = PORT) => new Promise(resolve =>
{
    const probe = new WebSocket(`ws://127.0.0.1:${port}`);
    probe.on("open", () => { probe.close(); resolve(false); });
    probe.on("error", () => resolve(true));
});
const keepTrying = async (ext, want = "welcome") => { let got; for (let i = 0; i < 20 && (got = await ext.connect()) !== want; i++) await sleep(200); return got; };

const broken = home();
writeFileSync(keyFile(broken), "not a key");
const corrupt = await agent("corrupt", { dir: broken });
const corruptAsked = Date.now();
const unreadable = await corrupt.call("get_status");
check("a bad key file: a clear error at once", unreadable.isError && /isn't a Hoverify key/.test(text(unreadable)) && Date.now() - corruptAsked < 1000, text(unreadable));
check("a bad key file: the port is left for the other sessions", await portFree());
await corrupt.client.close();

const A = await agent("A");
const key = readFileSync(keyFile(HOME), "utf8");
check("the first session writes a key only you can read", /^[0-9a-f]{64}$/.test(key) && (statSync(keyFile(HOME)).mode & 0o777) === 0o600 && (statSync(HOME).mode & 0o077) === 0, `${key} ${statSync(keyFile(HOME)).mode.toString(8)}`);

const tools = await A.client.listTools();
check("lists the ten tools", tools.tools.length === 10, tools.tools.map(t => t.name).join(","));

const started = Date.now();
const lonely = await A.call("get_status");
check("no browser: clear error after the wait", lonely.isError && /Connect to agent/.test(text(lonely)) && Date.now() - started < 8000, text(lonely));

const web = fakeExtension({ origin: "https://evil.example" });
await web.connect();
check("a web page origin is refused", web.events.closed?.code === 1008, JSON.stringify(web.events.closed));

const noOrigin = fakeExtension({ origin: null });
await noOrigin.connect();
check("an extension hello without an extension origin is refused", noOrigin.events.closed?.code === 1008 && !noOrigin.events.challenge, JSON.stringify(noOrigin.events.closed));

const old = fakeExtension({ protocol: 1 });
await old.connect();
await sleep(100);
check("a protocol mismatch is refused with a reason", old.events.closed?.code === 1008 && /protocol/.test(old.events.closed.reason), JSON.stringify(old.events.closed));
const outdated = await A.call("get_status");
check("and the agent hears it's a version mismatch", outdated.isError && /different versions/.test(text(outdated)), text(outdated));

const fresh = fakeExtension({ allow: false });
const firstContact = await fresh.connect();
const challenge = fresh.events.challenge;
check("a new browser is asked to allow the agent, by name", firstContact === "approval" && challenge?.agents.includes("test-A"), JSON.stringify(challenge));
check("the hub proves it holds the key file", challenge?.key_id === keyIdOf(key) && fresh.events.key === null, JSON.stringify(challenge));
const asked = Date.now();
const waiting = await A.call("get_status");
check("while it asks, the agent is told to click Allow", waiting.isError && /choose Allow/.test(text(waiting)) && Date.now() - asked < 7000, text(waiting));

const pairing = new Promise(resolve => { const t = setInterval(() => { if (fresh.events.welcome) { clearInterval(t); resolve(); } }, 20); });
fresh.allow();
await pairing;
check("allowing hands the browser the key and connects", fresh.key === key && fresh.events.welcome?.protocol === 2, JSON.stringify(fresh.events.welcome));
fresh.close();
await sleep(100);

const forged = fakeExtension({ key, badProof: true });
await forged.connect();
check("a browser that can't prove the key is refused", forged.events.closed?.code === 1008 && forged.events.closed.reason === "wrong key", JSON.stringify(forged.events.closed));

let ext = fakeExtension({ key });
check("a paired browser reconnects without asking", await ext.connect() === "welcome" && !ext.events.approval);

const status = await A.call("audit_seo", { format: "json" });
check("a call reaches the extension with its arguments", JSON.parse(text(status)).args.format === "json", text(status));

const B = await agent("B");
const relayed = await B.call("inspect_element", { selector: "#card" });
check("a second agent session relays through the hub", JSON.parse(text(relayed)).args.selector === "#card", text(relayed));
await sleep(100);
check("the browser sees both agents", ext.events.agents.includes("test-A") && ext.events.agents.includes("test-B"), JSON.stringify(ext.events.agents));

const otherHome = home();
const C = await agent("C", { dir: otherHome });
const refused = await C.call("get_status");
check("a session with another key file gets a clear error", refused.isError && /different key file/.test(text(refused)), text(refused));
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
ext = fakeExtension({ key });
await keepTrying(ext);
const retried = await inflight;
check("an idempotent call survives the hub exiting", !retried.isError && JSON.parse(text(retried)).tool === "audit_accessibility", text(retried));

const opened = B.call("open_url", { url: "http://localhost:3000/slow" });
await sleep(300);
ext.close();
const dropped = await opened;
check("a call with side effects is not retried after a drop", dropped.isError && /dropped/.test(text(dropped)), text(dropped));

await B.client.close();
await sleep(300);

// something else holds the port and answers like a hub, without the key
const heard = [];
const impostor = new WebSocketServer({ host: "127.0.0.1", port: PORT });
impostor.on("connection", socket => socket.on("message", raw =>
{
    const message = JSON.parse(String(raw));
    heard.push(message.type);
    if (message.type === "hello") socket.send(JSON.stringify({ type: "challenge", nonce: nonce(), key_id: keyIdOf(key), proof: "f".repeat(64), agents: [] }));
}));
await new Promise(r => impostor.once("listening", r));
const D = await agent("D");
const fooled = await D.call("get_status");
check("a session won't use a hub that can't prove the key", fooled.isError && /different key file/.test(text(fooled)) && heard.every(type => type === "hello"), `${text(fooled)} heard ${heard}`);
await D.client.close();
await new Promise(r => impostor.close(r));
await sleep(200);

unlinkSync(keyFile(HOME));
const E = await agent("E");
const after = fakeExtension({ key, allow: false });
check("a new key file asks the browser again", await keepTrying(after, "approval") === "approval" && after.events.challenge.key_id !== keyIdOf(key), JSON.stringify(after.events.challenge));
after.close();
await E.client.close();
await sleep(300);

// sessions that start together on a machine without a key must still agree on one
const crowdHome = home();
const crowd = await Promise.all(["P", "Q", "R"].map(name => agent(name, { dir: crowdHome, port: CROWD_PORT })));
const crowdKey = readFileSync(keyFile(crowdHome), "utf8");
const crowdExt = fakeExtension({ key: crowdKey, port: CROWD_PORT });
await keepTrying(crowdExt);
const answers = await Promise.all(crowd.map(session => session.call("get_status")));
check("sessions started together share one key", answers.every(a => !a.isError) && readdirSync(crowdHome).join() === "agent.key", `${answers.map(text)} ${readdirSync(crowdHome)}`);
crowdExt.close();
await Promise.all(crowd.map(session => session.client.close()));

for (const dir of [HOME, broken, otherHome, crowdHome]) rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
