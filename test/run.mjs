// Real MCP clients (each spawning the built server) against a fake extension on the WebSocket side.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket, WebSocketServer } from "ws";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = 47999;
const CROWD_PORT = 47997;
const IDLE_PORT = 47995;
const MULTI_PORT = 47993;
const PICK_PORT = 47991;
const PROJECT_PORT = 47989;
const ASK_PORT = 47987;
const VERSION_PORT = 47985;
const PAYLOAD_PORT = 47983;
const IDLE_MS = 1500;
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

// cwd / means no project, so the agent names stay plain unless a case gives it a folder
async function agent(name, { dir = HOME, port = PORT, idle = 0, args = [], env = {}, cwd = "/", entry = join(ROOT, "dist/index.js") } = {})
{
    const transport = new StdioClientTransport({
        command: process.execPath,
        cwd,
        args: [entry, ...args],
        env: { ...process.env, HOVERIFY_HOME: dir, HOVERIFY_MCP_PORT: String(port), ...(idle ? { HOVERIFY_MCP_IDLE_MS: String(idle) } : {}), ...env },
        stderr: "pipe",
    });
    const client = new Client({ name: `test-${name}`, version: "0" });
    await client.connect(transport);
    const call = async (tool, args = {}) => client.callTool({ name: tool, arguments: args });
    return { client, transport, call };
}

// key: the key it was allowed with before, or null for a browser that hasn't paired; allow: whether the user says yes at once
function fakeExtension({ origin = "chrome-extension://abcdefgh", key = null, protocol = 3, allow = true, badProof = false, port = PORT, browserId = "fake-browser-a", label = "Chrome", focused = false } = {})
{
    const browserState = { label, focused, focused_at: 0 };
    const events = { challenge: null, welcome: null, closed: null, approval: false, key: null, agents: [], sessions: [], calls: [] };
    let socket;
    let mine;
    const auth = (k, challenge) => socket.send(JSON.stringify({ type: "auth", proof: badProof ? "0".repeat(64) : prove(k, "client", challenge.nonce, mine) }));
    const connect = () => new Promise(resolve =>
    {
        mine = nonce();
        Object.assign(events, { challenge: null, welcome: null, closed: null, approval: false });
        socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers: origin ? { origin } : {} });
        socket.on("open", () => socket.send(JSON.stringify({ type: "hello", role: "ext", protocol, nonce: mine, browser: "Chrome 131", browser_id: browserId, extension_version: "9.9.9", ...browserState })));
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
            if (message.type === "welcome") { events.welcome = message; resolve(message.error ? "refused" : "welcome"); }
            if (message.type === "agents") { events.agents = message.agents; events.sessions = message.sessions || []; }
            if (message.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
            if (message.type !== "call") return;
            events.calls.push(message);
            const delay = message.args.delay_ms || (/\/slow|\.slow/.test(String(message.args.url || message.args.selector || "")) ? 1500 : 0);
            if (delay) await sleep(delay);
            const files = name => ({ name, data: Buffer.from(`bytes of ${name}`).toString("base64") });
            const output = message.tool === "capture"
                ? { content: [{ type: "text", text: "Screenshot of http://example.test/" }], files: [{ name: "capture-test.png", data: Buffer.from("png-bytes").toString("base64") }] }
                : message.tool === "download_assets"
                    ? { content: [{ type: "text", text: "Downloaded" }], files: [files("hoverify-assets-test/logo(1).svg"), files("../../escape.txt"), files("/etc/x/y/passwd")], files_label: "Saved files" }
                    : { content: [{ type: "text", text: JSON.stringify({ tool: message.tool, args: message.args }) }] };
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "result", id: message.id, ok: true, output }));
        });
        socket.on("close", (code, reason) => { events.closed = { code, reason: String(reason) }; resolve("closed"); });
        socket.on("error", () => resolve("closed"));
    });
    const state = patch => { Object.assign(browserState, patch); socket.send(JSON.stringify({ type: "browser", ...browserState })); };
    return { events, connect, state, allow: () => socket.send(JSON.stringify({ type: "pair" })), send: data => socket.send(data), close: () => socket?.close(), get key() { return key; } };
}

const text = result => result.content?.[0]?.text || "";
// this build announcing the next protocol, standing in for a newer release
function newerBuild()
{
    const dir = mkdtempSync(join(tmpdir(), "hoverify-mcp-newer-"));
    cpSync(join(ROOT, "dist"), join(dir, "dist"), { recursive: true });
    cpSync(join(ROOT, "package.json"), join(dir, "package.json"));
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
    const file = join(dir, "dist/protocol.js");
    writeFileSync(file, readFileSync(file, "utf8").replace(/PROTOCOL = (\d+)/, (_, n) => `PROTOCOL = ${Number(n) + 1}`));
    return dir;
}
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
check("lists the eighteen tools", tools.tools.length === 18, tools.tools.map(t => t.name).join(","));

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
check("allowing hands the browser the key and connects", fresh.key === key && fresh.events.welcome?.protocol === 3, JSON.stringify(fresh.events.welcome));
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
const sessionOf = (calls, selector) => calls.find(call => call.args.selector === selector)?.session;
const sessionA = ext.events.calls.find(call => call.tool === "audit_seo")?.session;
const sessionB = sessionOf(ext.events.calls, "#card");
check("each session's calls carry its own id", /^[\w-]{8,64}$/.test(sessionA) && /^[\w-]{8,64}$/.test(sessionB) && sessionA !== sessionB, `${sessionA} ${sessionB}`);

// a peer names its session once, in its first report after the handshake; neither a call nor a later report can claim another one
const rawPeer = (...messages) => new Promise(resolve =>
{
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const mine = nonce();
    socket.on("open", () => socket.send(JSON.stringify({ type: "hello", role: "peer", protocol: 3, nonce: mine })));
    socket.on("message", raw =>
    {
        const message = JSON.parse(String(raw));
        if (message.type === "challenge") socket.send(JSON.stringify({ type: "auth", proof: prove(key, "client", message.nonce, mine) }));
        if (message.type === "welcome") for (const next of messages) socket.send(JSON.stringify(next));
        if (message.type === "result") { socket.close(); resolve(message); }
    });
    socket.on("close", code => resolve({ closed: code }));
});
const rawCall = selector => ({ type: "call", id: `raw:${selector}`, tool: "inspect_element", args: { selector }, session: sessionA });
const rawResult = await rawPeer({ type: "agent", agent: "raw", session: "raw-session-1" }, { type: "agent", agent: "raw", session: "raw-session-2" }, rawCall("#raw"));
check("a call can't claim another session's id, nor a later report", rawResult.ok && sessionOf(ext.events.calls, "#raw") === "raw-session-1", JSON.stringify(rawResult));
const unreported = await rawPeer(rawCall("#unreported"));
await sleep(100);
check("a peer calling before it reports itself is dropped unrouted", unreported.closed === 1008 && !ext.events.calls.some(call => call.args.selector === "#unreported"), JSON.stringify(unreported));

const otherHome = home();
const C = await agent("C", { dir: otherHome });
const refused = await C.call("get_status");
check("a session with another key file gets a clear error", refused.isError && /different key file/.test(text(refused)), text(refused));
await C.client.close();
const unaffected = await B.call("get_status");
check("and the other sessions keep working", !unaffected.isError, text(unaffected));

const shot = await B.call("capture", { mode: "viewport" });
const saved = shot.content.find(c => /Full-resolution image: /.test(c.text || ""));
const path = saved?.text.replace("Full-resolution image: ", "");
check("capture files are written to disk and their path returned", path && existsSync(path) && readFileSync(path, "utf8") === "png-bytes", JSON.stringify(shot.content));
const page = await B.call("capture", { mode: "full_page" });
check("a full page capture reaches the browser", !page.isError && ext.events.calls.some(call => call.tool === "capture" && call.args.mode === "full_page"), JSON.stringify(page.content));
const rawShot = await B.call("capture", { mode: "viewport", raw: true });
check("a raw capture asks the browser for raw pixels", !rawShot.isError && ext.events.calls.some(call => call.tool === "capture" && call.args.raw === true), JSON.stringify(rawShot.content));
const areaShot = await B.call("capture", { mode: "area", area: { x: 0, y: 800, width: 400, height: 2000 } });
check("an area capture reaches the browser with its rectangle", !areaShot.isError && ext.events.calls.some(call => call.args.mode === "area" && call.args.area?.height === 2000), JSON.stringify(areaShot.content));
const downloaded = await B.call("download_assets", { types: ["svg"] });
const savedPaths = downloaded.content.map(c => c.text || "").join("\n").split("\n").filter(line => line.startsWith("- ")).map(line => line.slice(2));
const hoverifyDir = join(tmpdir(), "hoverify");
check("downloaded files are listed under their label", /Saved files:\n- /.test(downloaded.content.map(c => c.text).join("\n")) && savedPaths.length === 3, JSON.stringify(downloaded.content));
check("a grouped file lands in its folder", savedPaths[0] === join(hoverifyDir, "hoverify-assets-test", "logo(1).svg") && readFileSync(savedPaths[0], "utf8") === "bytes of hoverify-assets-test/logo(1).svg", savedPaths[0]);
check("no file name can leave the hoverify folder", savedPaths.every(path => path.startsWith(hoverifyDir + "/")) && savedPaths[1] === join(hoverifyDir, "escape.txt") && savedPaths[2] === join(hoverifyDir, "y", "passwd"), JSON.stringify(savedPaths));
const badArea = await B.call("capture", { mode: "area", area: { x: 0, y: 0, width: 0, height: 10 } });
check("an empty area is refused before it reaches the browser", badArea.isError, JSON.stringify(badArea.content));
const marked = await B.call("capture", { mode: "element", selector: "#card", annotations: [{ type: "highlight", selector: "#card h2", size: "l" }, { type: "magnifier", selector: "#card .price" }] });
check("an annotated capture reaches the browser with its annotations", !marked.isError && ext.events.calls.some(call => call.tool === "capture" && call.args.annotations?.[0]?.type === "highlight" && call.args.annotations[0].size === "l" && call.args.annotations[1].type === "magnifier"), JSON.stringify(marked.content));
const again = await B.call("capture", { capture_id: "abc", annotations: [{ type: "underline", selector: "#card" }] });
check("a capture_id needs no mode", !again.isError && ext.events.calls.some(call => call.tool === "capture" && call.args.capture_id === "abc" && call.args.mode === undefined), JSON.stringify(again.content));
const captureCalls = () => ext.events.calls.filter(call => call.tool === "capture").length;
const beforeMarks = captureCalls();
const refusedMarks = await Promise.all([
    B.call("capture", { mode: "viewport", annotations: [{ type: "squiggle", selector: "a" }] }),
    B.call("capture", { mode: "viewport", annotations: [{ type: "box", selector: "a", size: "xl" }] }),
    B.call("capture", { mode: "viewport", annotations: Array.from({ length: 41 }, () => ({ type: "box", selector: "a" })) }),
]);
check("unknown annotation types and sizes and too many annotations are refused before the browser", refusedMarks.every(r => r.isError) && captureCalls() === beforeMarks, JSON.stringify(refusedMarks.map(r => text(r).slice(0, 80))));
const designed = await B.call("design_screenshot", { mode: "element", selector: "#card", size: "x_one_image", background: { shader: "marble", palette: "site", settings: { pattern: "edge", swirl: 40 } }, layout: "diagonal", mirror: true, device: { model: "ipad_pro_13_m5" }, annotations: [{ type: "label", selector: "#card", text: "New", color: "#ff00ff" }] });
const designCall = ext.events.calls.find(call => call.tool === "design_screenshot");
check("a design reaches the browser with its recipe", !designed.isError && designCall?.args.background?.palette === "site" && designCall.args.background.settings?.swirl === 40 && designCall.args.background.settings.pattern === "edge" && designCall.args.layout === "diagonal" && designCall.args.mirror === true && designCall.args.annotations[0].text === "New" && designCall.args.device.model === "ipad_pro_13_m5", JSON.stringify(designed.content));
const designCalls = () => ext.events.calls.filter(call => call.tool === "design_screenshot").length;
const before = designCalls();
const refusedDesigns = await Promise.all([
    B.call("design_screenshot", { mode: "viewport", size: "x_post" }),
    B.call("design_screenshot", { mode: "viewport", background: "rainbow" }),
    B.call("design_screenshot", { mode: "viewport", annotations: Array.from({ length: 41 }, () => ({ type: "box", selector: "a" })) }),
    B.call("design_screenshot", { mode: "viewport", annotations: [{ type: "box", selector: "a", color: "red" }] }),
    B.call("design_screenshot", { mode: "viewport", device: { model: "nokia_3310" } }),
    B.call("design_screenshot", { mode: "viewport", background: { shader: "rays", palette: "site", settings: { glitter: 5 } } }),
    B.call("design_screenshot", { mode: "viewport", background: { shader: "rays", palette: "site", settings: { density: 150 } } }),
    B.call("design_screenshot", { mode: "viewport", layout: "spiral" }),
]);
check("unknown presets, too many annotations, bad colours and unknown or out-of-range shader settings are refused before the browser", refusedDesigns.every(r => r.isError) && designCalls() === before, JSON.stringify(refusedDesigns.map(r => text(r).slice(0, 80))));
const pictures = mkdtempSync(join(tmpdir(), "hoverify-pictures-"));
writeFileSync(join(pictures, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
writeFileSync(join(pictures, "notes.txt"), "not a picture");
const composed = await B.call("design_screenshot", { mode: "viewport", annotations: [
    { type: "text", text: "Simple pricing\nfor everyone", at: { anchor: "left", margin: "large" }, role: "headline", font: "site_heading", color: "auto" },
    { type: "image", path: join(pictures, "logo.png"), at: { anchor: "top_left" }, size: "s" },
    { type: "image", url: "https://example.com/logo.svg", at: { anchor: "top_right" } },
] });
const composedCall = ext.events.calls.filter(call => call.tool === "design_screenshot").pop();
const [headline, logo, remote] = composedCall?.args.annotations ?? [];
check("canvas text reaches the browser with its anchor, role and font", !composed.isError && headline?.at?.anchor === "left" && headline.role === "headline" && headline.font === "site_heading" && headline.color === "auto" && headline.text.includes("\n"), JSON.stringify(composed.content));
check("a picture's path goes over as its bytes, never the path", logo?.data === "data:image/png;base64,iVBORw==" && logo.path === undefined, JSON.stringify(logo));
check("a picture's url goes over for the browser to fetch", remote?.url === "https://example.com/logo.svg" && remote.data === undefined, JSON.stringify(remote));
const designsSoFar = () => ext.events.calls.filter(call => call.tool === "design_screenshot").length;
const beforePictures = designsSoFar();
const refusedPictures = await Promise.all([
    B.call("design_screenshot", { mode: "viewport", annotations: [{ type: "image", path: join(pictures, "missing.png"), at: { anchor: "top" } }] }),
    B.call("design_screenshot", { mode: "viewport", annotations: [{ type: "image", path: join(pictures, "notes.txt"), at: { anchor: "top" } }] }),
    B.call("design_screenshot", { mode: "viewport", annotations: [{ type: "image", path: pictures, at: { anchor: "top" } }] }),
    B.call("design_screenshot", { mode: "viewport", annotations: [{ type: "text", text: "Hi", at: { anchor: "middle" } }] }),
    B.call("design_screenshot", { mode: "viewport", annotations: [{ type: "text", text: "Hi", at: { anchor: "top" }, role: "title" }] }),
]);
check("a missing, non-picture or folder path, an unknown anchor and an unknown role are refused before the browser", refusedPictures.every(r => r.isError) && designsSoFar() === beforePictures && /can't be read/.test(text(refusedPictures[0])) && /isn't a PNG/.test(text(refusedPictures[1])), JSON.stringify(refusedPictures.map(r => text(r).slice(0, 80))));
rmSync(pictures, { recursive: true, force: true });
const paired = await B.call("design_screenshot", { mode: "viewport", layout: "pair_fan", shots: [{ capture_id: "abc" }, { mode: "element", selector: "#card", tab_id: 7 }].slice(0, 1) });
const pairCall = ext.events.calls.filter(call => call.tool === "design_screenshot").pop();
check("a multi-shot design reaches the browser with its shots and layout", !paired.isError && pairCall?.args.layout === "pair_fan" && pairCall.args.shots?.[0]?.capture_id === "abc", JSON.stringify(paired.content));
const beforeShots = designsSoFar();
const refusedShots = await Promise.all([
    B.call("design_screenshot", { mode: "viewport", shots: [{ capture_id: "a" }, { capture_id: "b" }, { capture_id: "c" }] }),
    B.call("design_screenshot", { mode: "viewport", layout: "pair_spiral" }),
    B.call("design_screenshot", { mode: "viewport", shots: [{ mode: "page" }] }),
]);
check("more than 2 extra shots, an unknown layout and a bad shot mode are refused before the browser", refusedShots.every(r => r.isError) && designsSoFar() === beforeShots, JSON.stringify(refusedShots.map(r => text(r).slice(0, 80))));
const free = await B.call("design_screenshot", { mode: "viewport", background: { gradient: ["#0f172a", "#7c3aed"], angle: 120 }, shot: { scale: 140, x: 70, tilt_y: -12 }, annotations: [
    { type: "shape", shape: "pill", at: { x: 8, y: 10 }, width: 12, height: 5, fill: "#facc15", rotation: -4, opacity: 90 },
    { type: "text", text: "New", at: { x: 8, y: 10 }, font_size: 40, letter_spacing: 4, background: "#facc15" },
    { type: "shape", shape: "line", at: { x: 8, y: 30 }, to: { x: 40, y: 30 }, stroke: "#ffffff", stroke_width: 3 },
    { type: "label", selector: "#card", text: "Here", side: "left" },
] });
const freeCall = ext.events.calls.filter(call => call.tool === "design_screenshot").pop();
check("free placement, raw type, shapes, a shot placement and a gradient reach the browser", !free.isError && freeCall?.args.annotations?.[0]?.shape === "pill" && freeCall.args.annotations[1].font_size === 40 && freeCall.args.annotations[2].to?.x === 40 && freeCall.args.annotations[3].side === "left" && freeCall.args.shot?.tilt_y === -12 && freeCall.args.background?.gradient?.length === 2, JSON.stringify(free.content));
const beforeFree = designsSoFar();
const refusedFree = await Promise.all([
    B.call("design_screenshot", { mode: "viewport", annotations: [{ type: "text", text: "x", at: { x: 200, y: 10 } }] }),
    B.call("design_screenshot", { mode: "viewport", annotations: [{ type: "shape", shape: "star", at: { x: 1, y: 1 } }] }),
    B.call("design_screenshot", { mode: "viewport", shot: { scale: 400 } }),
    B.call("design_screenshot", { mode: "viewport", background: { gradient: ["#000000"] } }),
    B.call("design_screenshot", { mode: "viewport", annotations: [{ type: "label", selector: "a", text: "x", side: "middle" }] }),
]);
check("out-of-range placement, unknown shapes and sides, a shot too large and a one-colour gradient are refused before the browser", refusedFree.every(r => r.isError) && designsSoFar() === beforeFree, JSON.stringify(refusedFree.map(r => text(r).slice(0, 80))));
const artPictures = mkdtempSync(join(tmpdir(), "hoverify-art-"));
writeFileSync(join(artPictures, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
const arty = await B.call("design_screenshot", { mode: "none", size: "web_open_graph", background: { shader: "silk", colors: ["#2563eb", "#7c3aed"], dark: false }, effects: { noise: 0, blur: 2 }, art: [
    { type: "glow", at: { x: 70, y: 30 }, width: 50, color: "#2563eb80", blend: "screen" },
    { type: "pattern", pattern: "dots", color: "#ffffff", spacing: 40, size: 3, fade: "edges", opacity: 20 },
    { type: "text", text: "4.9", at: { x: 50, y: 50, origin: "center" }, font_size: 600, weight: "extrabold", stroke: "#ffffff40", stroke_width: 3, letter_spacing: -20 },
    { type: "image", path: join(artPictures, "photo.png") },
    { type: "grain", opacity: 12 },
    { type: "pattern", pattern: "scatter", seed: 3, color: "#ffffff", spacing: 40 },
    { type: "shape", shape: "ellipse", at: { x: 50, y: 175, origin: "center" }, width: 170, height: 160, color: "#0b1230" },
], annotations: [{ type: "text", text: "Out now", at: { x: 8, y: 8 }, weight: "thin" }] });
const artCall = ext.events.calls.filter(call => call.tool === "design_screenshot").pop();
const [light, dots, type, photo] = artCall?.args.art ?? [];
check("art, no shot, the Open Graph size, the agent's shader colours and effects reach the browser", !arty.isError && artCall.args.size === "web_open_graph" && artCall.args.art[5]?.pattern === "scatter" && artCall.args.art[6]?.at.y === 175 && artCall.args.mode === "none" && artCall.args.background?.colors?.length === 2 && artCall.args.background.dark === false && artCall.args.effects?.noise === 0 && light?.blend === "screen" && light.color === "#2563eb80" && dots?.fade === "edges" && type?.weight === "extrabold" && type.letter_spacing === -20 && artCall.args.annotations[0].weight === "thin", JSON.stringify(arty.content));
check("an art picture's path goes over as its bytes", photo?.data === "data:image/png;base64,iVBORw==" && photo.path === undefined, JSON.stringify(photo));
rmSync(artPictures, { recursive: true, force: true });
const beforeArt = designsSoFar();
const refusedArt = await Promise.all([
    B.call("design_screenshot", { mode: "none", art: [{ type: "sparkle" }] }),
    B.call("design_screenshot", { mode: "none", art: Array.from({ length: 41 }, () => ({ type: "grain" })) }),
    B.call("design_screenshot", { mode: "none", art: [{ type: "glow", color: "#00ffff", blend: "glow" }] }),
    B.call("design_screenshot", { mode: "none", art: [{ type: "glow", color: "cyan" }] }),
    B.call("design_screenshot", { mode: "none", art: [{ type: "pattern", pattern: "zigzag" }] }),
    B.call("design_screenshot", { mode: "none", effects: { noise: 150 } }),
    B.call("design_screenshot", { mode: "none", art: [{ type: "glow", at: { x: 50, y: 250 }, color: "#00ffff" }] }),
    B.call("design_screenshot", { mode: "none", background: { shader: "silk", colors: ["#000000", "#111111", "#222222", "#333333"] } }),
    B.call("design_screenshot", { mode: "page" }),
]);
check("unknown art kinds, blends and patterns, too many layers, bad colours, places past 200%, out-of-range effects and too many shader colours are refused before the browser", refusedArt.every(r => r.isError) && designsSoFar() === beforeArt, JSON.stringify(refusedArt.map(r => text(r).slice(0, 80))));

// the hub exits mid-call: the idempotent call is retried once the extension reconnects to the new hub
const inflight = B.call("inspect_element", { selector: "#takeover.slow" });
await sleep(300);
await A.client.close();
await sleep(400);
ext = fakeExtension({ key });
await keepTrying(ext);
const retried = await inflight;
check("an idempotent call survives the hub exiting", !retried.isError && JSON.parse(text(retried)).args.selector === "#takeover.slow" && ext.events.calls.length > 0, text(retried));

check("a session keeps its id across a hub takeover", ext.events.calls.length > 0 && ext.events.calls.every(call => call.session === sessionB), JSON.stringify(ext.events.calls.map(call => call.session)));

const opened = B.call("open_url", { url: "http://localhost:3000/slow" });
await sleep(300);
ext.close();
const dropped = await opened;
check("a call with side effects is not retried after a drop", dropped.isError && /dropped/.test(text(dropped)), text(dropped));

await B.client.close();
await sleep(300);

// something else holds the port and answers like a hub, without the key: first with a proof it can't make, then skipping the challenge
const heard = [];
const hellos = [];
const impostor = new WebSocketServer({ host: "127.0.0.1", port: PORT });
impostor.on("connection", socket => socket.on("message", raw =>
{
    const message = JSON.parse(String(raw));
    heard.push(message.type);
    if (message.type !== "hello") return;
    hellos.push(String(raw));
    socket.send(JSON.stringify(hellos.length % 2
        ? { type: "challenge", nonce: nonce(), key_id: keyIdOf(key), proof: "f".repeat(64), agents: [] }
        : { type: "welcome", protocol: 3 }));
}));
await new Promise(r => impostor.once("listening", r));
const squatted = realpathSync(mkdtempSync(join(tmpdir(), "squatted-")));
const D = await agent("D", { cwd: squatted });
const fooled = await D.call("get_status");
for (let i = 0; i < 50 && hellos.length < 2; i++) await sleep(100);
await sleep(300);
const skipped = await D.call("get_status");
check("a session won't use a hub that can't prove the key", fooled.isError && /different key file/.test(text(fooled)) && heard.every(type => type === "hello"), `${text(fooled)} heard ${heard}`);
check("nor one that skips the challenge", hellos.length >= 2 && skipped.isError && /different key file/.test(text(skipped)) && heard.every(type => type === "hello"), `${text(skipped)} heard ${heard}`);
check("its hello names no agent, session or project folder", hellos.every(hello => !hello.includes(squatted) && Object.keys(JSON.parse(hello)).sort().join() === "nonce,protocol,role,type"), hellos.join(" "));
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

// sessions left open with nothing to do let go of the port and take it back on their next call
const idleHome = home();
const X = await agent("X", { dir: idleHome, port: IDLE_PORT, idle: IDLE_MS });
await sleep(300);
const idleKey = readFileSync(keyFile(idleHome), "utf8");
let idleExt = fakeExtension({ key: idleKey, port: IDLE_PORT });
await keepTrying(idleExt);
const Y = await agent("Y", { dir: idleHome, port: IDLE_PORT, idle: IDLE_MS });
const viaPeer = await Y.call("get_status");
check("an idle test session relays like any other", !viaPeer.isError && idleExt.events.agents.includes("test-Y"), `${text(viaPeer)} ${idleExt.events.agents}`);
const long = await Y.call("audit_accessibility", { delay_ms: IDLE_MS * 2 });
check("a peer doesn't leave the hub in the middle of a call", !long.isError, text(long));
await sleep(IDLE_MS * 2);
check("an idle peer leaves the hub", !idleExt.events.agents.includes("test-Y") && idleExt.events.agents.includes("test-X"), JSON.stringify(idleExt.events.agents));
check("a hub with the browser connected keeps the port", !await portFree(IDLE_PORT) && !idleExt.events.closed, JSON.stringify(idleExt.events.closed));
const rejoined = await Y.call("inspect_element", { selector: "#again" });
check("the idle peer's next call rejoins the hub", !rejoined.isError && idleExt.events.agents.includes("test-Y"), `${text(rejoined)} ${idleExt.events.agents}`);

idleExt.close();
await sleep(IDLE_MS * 4);
check("with the browser gone, idle sessions let go of the port", await portFree(IDLE_PORT));
const waking = Y.call("get_status");
idleExt = fakeExtension({ key: idleKey, port: IDLE_PORT });
check("the next call takes the port back", await keepTrying(idleExt) === "welcome");
const woke = await waking;
check("and reaches the browser", !woke.isError && JSON.parse(text(woke)).tool === "get_status", text(woke));
const relayedAgain = await X.call("get_status");
check("the old hub's session joins the new one", !relayedAgain.isError && idleExt.events.agents.includes("test-X"), `${text(relayedAgain)} ${idleExt.events.agents}`);
idleExt.close();
await Promise.all([X, Y].map(session => session.client.close()));

// two browsers switched on at once, like Chrome and Helium: each keeps its own connection
const allText = result => result.content.map(c => c.text || "").join("\n");
const multiHome = home();
const M = await agent("M", { dir: multiHome, port: MULTI_PORT });
await sleep(300);
const multiKey = readFileSync(keyFile(multiHome), "utf8");
const chrome = fakeExtension({ key: multiKey, port: MULTI_PORT, browserId: "chrome-install-1" });
const helium = fakeExtension({ key: multiKey, port: MULTI_PORT, browserId: "helium-install-1" });
await keepTrying(chrome);
const firstCall = await M.call("inspect_element", { selector: "#m-first" });
await keepTrying(helium);
await sleep(300);
check("a second browser doesn't push the first one off", !chrome.events.closed && !helium.events.closed && !firstCall.isError, JSON.stringify([chrome.events.closed, helium.events.closed]));

// chrome reconnecting puts helium first in line, so a new session lands there while M stays put
chrome.close();
await sleep(200);
await keepTrying(chrome);
const N = await agent("N", { dir: multiHome, port: MULTI_PORT });
const nFirst = await N.call("inspect_element", { selector: "#n-first" });
const mAgain = await M.call("inspect_element", { selector: "#m-again" });
const ranIn = (ext, selector) => ext.events.calls.some(call => call.args.selector === selector);
check("a new session's first call goes to the first browser connected", !nFirst.isError && ranIn(helium, "#n-first") && !ranIn(chrome, "#n-first"));
check("a session stays in the browser its first call ran in", !mAgain.isError && ranIn(chrome, "#m-again") && !ranIn(helium, "#m-again"));

const onHelium = N.call("inspect_element", { selector: "#n.slow" });
const onChrome = M.call("inspect_element", { selector: "#m-moved.slow" });
await sleep(300);
chrome.close();
const [heliumResult, chromeResult] = await Promise.all([onHelium, onChrome]);
check("one browser dropping leaves calls in the other alone", !heliumResult.isError && !/different browser/.test(allText(heliumResult)), allText(heliumResult));
check("a session whose browser is gone moves and says so", !chromeResult.isError && /different browser/.test(allText(chromeResult)) && ranIn(chrome, "#m-moved.slow") && ranIn(helium, "#m-moved.slow"), allText(chromeResult));

const heliumAgain = fakeExtension({ key: multiKey, port: MULTI_PORT, browserId: "helium-install-1" });
await keepTrying(heliumAgain);
await sleep(200);
check("a browser reconnecting replaces only its own old connection", helium.events.closed?.reason === "replaced" && !heliumAgain.events.closed, JSON.stringify(helium.events.closed));
heliumAgain.close();
await Promise.all([M, N].map(session => session.client.close()));

// picking a browser: by name, by the project's config, or the one the user used last
const pickHome = home();
const P1 = await agent("P1", { dir: pickHome, port: PICK_PORT });
await sleep(300);
const pickKey = readFileSync(keyFile(pickHome), "utf8");
const work = fakeExtension({ key: pickKey, port: PICK_PORT, browserId: "chrome-work-0001", label: "Chrome" });
const side = fakeExtension({ key: pickKey, port: PICK_PORT, browserId: "helium-side-0001", label: "Helium", focused: true });
await keepTrying(work);
await keepTrying(side);

await P1.call("inspect_element", { selector: "#p1-first" });
check("a new session starts in the browser in use", ranIn(side, "#p1-first") && !ranIn(work, "#p1-first"));
side.state({ focused: false, focused_at: Date.now() });
work.state({ focused: true, focused_at: Date.now() });
await sleep(100);
const P2 = await agent("P2", { dir: pickHome, port: PICK_PORT });
await P2.call("inspect_element", { selector: "#p2-first" });
await P1.call("inspect_element", { selector: "#p1-again" });
check("focus moving on sends the next new session along", ranIn(work, "#p2-first"));
check("while a session that already started stays put", ranIn(side, "#p1-again"));
work.state({ focused: false, focused_at: Date.now() });
await sleep(100);
const P3 = await agent("P3", { dir: pickHome, port: PICK_PORT });
await P3.call("inspect_element", { selector: "#p3-first" });
check("with no browser in focus, the one used last wins", ranIn(work, "#p3-first"));

await P1.call("inspect_element", { selector: "#asked", browser: "chrome" });
await P1.call("inspect_element", { selector: "#after-asked" });
const askedCall = work.events.calls.find(call => call.args.selector === "#asked");
check("browser picks one by name, and the session stays there", askedCall && !("browser" in askedCall.args) && ranIn(work, "#after-asked"), JSON.stringify(askedCall));

const unknown = await P1.call("get_status", { browser: "firefox" });
check("an unknown name fails and lists what's connected", unknown.isError && /firefox isn't connected/.test(text(unknown)) && /Chrome \(id chrome-w\)/.test(text(unknown)) && /Helium \(id helium-s\)/.test(text(unknown)), text(unknown));
const pickedStatus = allText(await P1.call("get_status"));
check("get_status names the browser, why, and the others", /Browser: Chrome \(id chrome-w\), because you asked for it with browser/.test(pickedStatus) && /- Helium \(id helium-s\)/.test(pickedStatus), pickedStatus);

side.state({ label: "Chrome" });
await sleep(100);
const twin = await P1.call("get_status", { browser: "chrome" });
check("two browsers with one name ask for an id", twin.isError && /More than one connected browser is named chrome/.test(text(twin)), text(twin));
await P1.call("inspect_element", { selector: "#by-id", browser: "helium-s" });
check("and the start of an id picks one", ranIn(side, "#by-id"));
side.state({ label: "Helium" });

work.state({ focused: true, focused_at: Date.now() });
await sleep(100);
const C1 = await agent("C1", { dir: pickHome, port: PICK_PORT, args: ["--browser", "helium"] });
await C1.call("inspect_element", { selector: "#c1" });
check("--browser in the config wins over the browser in use", ranIn(side, "#c1") && !ranIn(work, "#c1"));
const C2 = await agent("C2", { dir: pickHome, port: PICK_PORT, env: { HOVERIFY_BROWSER: "Helium" } });
const c2Status = allText(await C2.call("get_status"));
check("so does HOVERIFY_BROWSER, and get_status says why", /because this project's MCP config sets --browser Helium/.test(c2Status), c2Status);
await C2.call("inspect_element", { selector: "#c2-asked", browser: "chrome" });
const c2After = await C2.call("inspect_element", { selector: "#c2-after" });
check("a browser the agent was asked for outlasts the project's config", ranIn(work, "#c2-asked") && ranIn(work, "#c2-after") && !ranIn(side, "#c2-after"), allText(c2After));
side.close();
const gone = await C1.call("inspect_element", { selector: "#c1-gone" });
check("a configured browser that's gone is never swapped for another", gone.isError && /helium isn't connected/.test(text(gone)) && !ranIn(work, "#c1-gone"), text(gone));
work.close();
await Promise.all([P1, P2, P3, C1, C2].map(session => session.client.close()));

// projects: a session reports its folder, and a browser can keep a project or refuse every other one
const projectHome = home();
const landing = realpathSync(mkdtempSync(join(tmpdir(), "landing-")));
const blog = realpathSync(mkdtempSync(join(tmpdir(), "blog-")));
const landingName = landing.split("/").pop();
const L = await agent("L", { dir: projectHome, port: PROJECT_PORT, cwd: landing });
await sleep(300);
const projectKey = readFileSync(keyFile(projectHome), "utf8");
const asking = fakeExtension({ key: null, port: PROJECT_PORT, browserId: "asking-0001", allow: false });
await keepTrying(asking, "approval");
check("the allow prompt names the agent's project", asking.events.challenge?.agents.includes(`test-L in ${landingName}`), JSON.stringify(asking.events.challenge?.agents));
const peek = await agent("peek", { dir: projectHome, port: PROJECT_PORT, cwd: blog });
await sleep(300);
check("a browser still asking hears new agents' names, not their folders", asking.events.agents.some(name => name.startsWith("test-peek in blog-")) && !asking.events.sessions.length, JSON.stringify(asking.events));
await peek.client.close();
asking.close();

const chromeP = fakeExtension({ key: projectKey, port: PROJECT_PORT, browserId: "chrome-proj-0001", label: "Chrome", focused: true });
const heliumP = fakeExtension({ key: projectKey, port: PROJECT_PORT, browserId: "helium-proj-0001", label: "Helium" });
await keepTrying(chromeP);
await keepTrying(heliumP);
const B2 = await agent("B2", { dir: projectHome, port: PROJECT_PORT, cwd: blog });
await L.call("inspect_element", { selector: "#l-first" });
await B2.call("inspect_element", { selector: "#b-first" });
await sleep(100);
const listed = chromeP.events.sessions.find(session => session.agent === "test-L");
check("browsers see each session's project and browser", listed?.project?.path === landing && listed.browser === "chrome-proj-0001" && listed.browser_label === "Chrome" && heliumP.events.sessions.some(session => session.agent === "test-B2"), JSON.stringify(chromeP.events.sessions));

heliumP.state({ claims: [landing] });
await sleep(100);
const kept = await L.call("inspect_element", { selector: "#l-kept" });
check("a project kept in a browser moves its session there, and says so", ranIn(heliumP, "#l-kept") && /the browser the user keeps this project in/.test(allText(kept)), allText(kept));
const K = await agent("K", { dir: projectHome, port: PROJECT_PORT, cwd: landing });
await K.call("inspect_element", { selector: "#k-first" });
check("a peer reports its project before its first call", ranIn(heliumP, "#k-first") && !ranIn(chromeP, "#k-first"));
await K.client.close();
await B2.call("inspect_element", { selector: "#b-still" });
check("other projects carry on where they were", ranIn(chromeP, "#b-still"));
const keptStatus = allText(await L.call("get_status"));
check("get_status names the project and why it's there", new RegExp(`because the user keeps ${landingName} in it`).test(keptStatus) && keptStatus.includes(`Project: ${landingName} (${landing})`), keptStatus);
const C3 = await agent("C3", { dir: projectHome, port: PROJECT_PORT, cwd: landing, args: ["--browser", "chrome-proj"] });
await C3.call("inspect_element", { selector: "#c3" });
check("the project's MCP config wins over a browser keeping it", ranIn(chromeP, "#c3"));
await sleep(100);
const c3Listed = heliumP.events.sessions.find(session => session.agent === "test-C3");
check("browsers hear which browser a binding resolves to, even by id", c3Listed?.bound?.by === "config" && c3Listed.bound.name === "chrome-proj" && c3Listed.bound.ids.join() === "chrome-proj-0001", JSON.stringify(c3Listed));

heliumP.close();
await sleep(300);
const offNow = chromeP.events.sessions.find(session => session.agent === "test-L");
await keepTrying(heliumP);
await sleep(300);
const backAgain = chromeP.events.sessions.find(session => session.agent === "test-L");
check("a browser coming back is named again in the other browsers' lists", offNow?.browser_label === "" && backAgain?.browser_label === "Helium", JSON.stringify([offNow, backAgain]));

await L.call("inspect_element", { selector: "#l-asked", browser: "chrome" });
const lAfter = await L.call("inspect_element", { selector: "#l-after" });
await sleep(100);
const lListed = heliumP.events.sessions.find(session => session.agent === "test-L");
check("a browser the agent was asked for outlasts a browser keeping the project", ranIn(chromeP, "#l-after") && !/keeps this project in/.test(allText(lAfter)) && lListed?.bound?.by === "argument" && lListed.bound.ids.join() === "chrome-proj-0001", JSON.stringify(lListed));

heliumP.state({ claims: [landing], only: true });
await sleep(100);
const turnedAway = await B2.call("get_status", { browser: "helium" });
check("a browser keeping only its projects turns others away, even by name", turnedAway.isError && /Helium only works for the projects the user keeps in it/.test(text(turnedAway)), text(turnedAway));
chromeP.close();
const nowhere = await B2.call("inspect_element", { selector: "#b-nowhere" });
check("and with only that browser left, other projects get nowhere", nowhere.isError && /Every connected browser/.test(text(nowhere)) && !ranIn(heliumP, "#b-nowhere"), text(nowhere));
heliumP.close();
await Promise.all([L, B2, C3].map(session => session.client.close()));

// a browser the agent was asked for is held by id: a newcomer with its name, a rename or a hub takeover doesn't move the session
const askHome = home();
const H = await agent("H", { dir: askHome, port: ASK_PORT });
await sleep(300);
const askKey = readFileSync(keyFile(askHome), "utf8");
const held = fakeExtension({ key: askKey, port: ASK_PORT, browserId: "held-ask-0001" });
await keepTrying(held);
const P = await agent("P", { dir: askHome, port: ASK_PORT });
await P.call("inspect_element", { selector: "#p-asked", browser: "chrome" });
const twinAsk = fakeExtension({ key: askKey, port: ASK_PORT, browserId: "twin-ask-0001", focused: true });
await keepTrying(twinAsk);
const afterTwin = await P.call("inspect_element", { selector: "#p-twin" });
check("a newcomer with the same name doesn't unsettle a browser the agent asked for", !afterTwin.isError && ranIn(held, "#p-twin") && !ranIn(twinAsk, "#p-twin"), text(afterTwin));
held.state({ label: "Work" });
await sleep(100);
const afterRename = await P.call("inspect_element", { selector: "#p-renamed" });
check("nor does renaming it", !afterRename.isError && ranIn(held, "#p-renamed"), text(afterRename));
const Q = await agent("Q", { dir: askHome, port: ASK_PORT });
await Q.call("get_status");
await H.client.close();
await sleep(400);
await keepTrying(held);
await keepTrying(twinAsk);
await sleep(300);
const heldListed = twinAsk.events.sessions.find(session => session.agent === "test-P");
check("after a hub takeover the browsers still see what the session asked for", heldListed?.bound?.by === "argument" && heldListed.bound.name === "Work" && heldListed.bound.ids.join() === "held-ask-0001", JSON.stringify(heldListed));
// parallel tool calls: a slow call sent before the agent asked for another browser finishes late
const slowCall = P.call("inspect_element", { selector: "#p-race.slow" });
await sleep(200);
await P.call("inspect_element", { selector: "#p-race-ask", browser: "twin-ask-0001" });
await slowCall;
await P.call("inspect_element", { selector: "#p-race-after" });
check("a call that finishes late can't move the browser the agent asked for", ranIn(held, "#p-race.slow") && ranIn(twinAsk, "#p-race-after") && !ranIn(held, "#p-race-after"));
await P.call("inspect_element", { selector: "#p-back", browser: "Work" });

held.close();
await sleep(200);
const offListed = twinAsk.events.sessions.find(session => session.agent === "test-P");
const heldGone = await P.call("inspect_element", { selector: "#p-gone" });
check("a browser the agent asked for that's gone fails instead of moving", heldGone.isError && /^The browser this session was asked to use \(id held-ask\) isn't connected/.test(text(heldGone)) && !text(heldGone).includes("held-ask-0001") && !ranIn(twinAsk, "#p-gone"), text(heldGone));
check("and the other browsers' lists leave its name blank rather than show an id", offListed?.bound?.by === "argument" && offListed.bound.name === "" && offListed.bound.ids.join() === "held-ask-0001", JSON.stringify(offListed));
twinAsk.close();
await Promise.all([P, Q].map(session => session.client.close()));

// an update: a session on a newer protocol takes the port from an older hub no browser uses, and older sessions never take it back
const versionHome = home();
const newer = newerBuild();
const elder = await agent("elder", { dir: versionHome, port: VERSION_PORT });
await sleep(400);
const elderPeer = await agent("elder-peer", { dir: versionHome, port: VERSION_PORT });
await sleep(400);
const versionKey = readFileSync(keyFile(versionHome), "utf8");

const squatOutcome = await new Promise(resolve =>
{
    const socket = new WebSocket(`ws://127.0.0.1:${VERSION_PORT}`);
    socket.on("open", () => socket.send(JSON.stringify({ type: "hello", role: "peer", protocol: 99, nonce: nonce() })));
    socket.on("message", raw => { if (JSON.parse(String(raw)).type === "challenge") socket.send(JSON.stringify({ type: "auth", proof: "0".repeat(64) })); });
    socket.on("close", (code, reason) => resolve(`${code} ${reason}`));
});
const holder = fakeExtension({ key: versionKey, port: VERSION_PORT });
check("a newer hello without the key can't take the port", squatOutcome === "1008 wrong key" && await keepTrying(holder) === "welcome", squatOutcome);

const young = await agent("young", { dir: versionHome, port: VERSION_PORT, entry: join(newer, "dist/index.js") });
const youngRefused = await young.call("get_status");
const elderStill = await elder.call("inspect_element", { selector: "#elder" });
check("an older hub a browser uses keeps the port", youngRefused.isError && /different version of hoverify-mcp/.test(text(youngRefused)) && !elderStill.isError && ranIn(holder, "#elder"), `${text(youngRefused)} | ${text(elderStill)}`);

holder.close();
const updated = fakeExtension({ key: versionKey, port: VERSION_PORT, protocol: 4, browserId: "fake-browser-new" });
const tookOver = await keepTrying(updated);
const youngNow = await young.call("inspect_element", { selector: "#young" });
check("with no browser left, the newer session takes the port", tookOver === "welcome" && !youngNow.isError && ranIn(updated, "#young"), `${tookOver} ${text(youngNow)}`);
const elderNow = await elder.call("get_status");
const elderPeerNow = await elderPeer.call("get_status");
check("and the older sessions are told to restart", [elderNow, elderPeerNow].every(r => r.isError && /different version of hoverify-mcp/.test(text(r))), `${text(elderNow)} | ${text(elderPeerNow)}`);
await sleep(3500);
const youngLater = await young.call("inspect_element", { selector: "#young-later" });
check("they don't take the port back", !youngLater.isError && ranIn(updated, "#young-later") && !updated.events.closed, `${text(youngLater)} ${JSON.stringify(updated.events.closed)}`);
updated.close();
await Promise.all([elder, elderPeer, young].map(session => session.client.close()));

// a message over the hub's 64 MB limit drops that browser's connection, never the server every agent session goes through
const payloadHome = home();
const O = await agent("O", { dir: payloadHome, port: PAYLOAD_PORT });
await sleep(300);
const payloadKey = readFileSync(keyFile(payloadHome), "utf8");
const flooding = fakeExtension({ key: payloadKey, port: PAYLOAD_PORT });
await keepTrying(flooding);
const flooded = O.call("open_url", { url: "http://localhost:3000/slow" });
await sleep(300);
flooding.send("x".repeat(64 * 1024 * 1024 + 1));
const floodedResult = await flooded;
check("a message over 64 MB drops its browser and that browser's calls", floodedResult.isError && /dropped/.test(text(floodedResult)) && flooding.events.closed?.code === 1009, `${text(floodedResult)} ${JSON.stringify(flooding.events.closed)}`);
const afterFlood = fakeExtension({ key: payloadKey, port: PAYLOAD_PORT });
const reconnected = await keepTrying(afterFlood);
const served = await O.call("inspect_element", { selector: "#after-flood" });
check("and the server keeps serving", reconnected === "welcome" && !served.isError && ranIn(afterFlood, "#after-flood"), text(served));
afterFlood.close();
await O.client.close();

for (const dir of [HOME, broken, otherHome, squatted, crowdHome, idleHome, multiHome, pickHome, projectHome, landing, blog, askHome, versionHome, newer, payloadHome]) rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
