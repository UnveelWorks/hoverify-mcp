import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
    PROTOCOL,
    PING_INTERVAL,
    NOT_CONNECTED,
    APPROVAL_NEEDED,
    PEER_REJECTED,
    PEER_VERSION,
    EXTENSION_VERSION,
    BRIDGE_RESET,
    BROWSER_MOVED,
    BROWSER_CLAIMED,
    CallMessage,
    ResultMessage,
    ExtensionHello,
    BrowserState,
    PeerHello,
    ToolOutput,
    BrowserInfo,
    Picked,
    Project,
    SessionInfo,
    Bound,
} from "./protocol.js";
import * as Browsers from "./browsers.js";
import { keyId, loadKey, nonce, prove, proves } from "./key.js";

export interface BridgeOptions
{
    port: number;
    name: string;
    releaseAfter: number;
    agent: () => string;
    configured: string;
    log: (line: string) => void;
}

interface Browser
{
    id: string;
    socket: WebSocket;
    label: string;
    focused: boolean;
    focused_at: number;
    claims: string[];
    only: boolean;
}

interface Peer
{
    agent: string;
    session: string;
    project: Project | null;
    configured: string;
    pinned: string;
    asked: boolean;
}

interface Route
{
    peer: WebSocket | null;
    socket: WebSocket;
    picked: Picked;
    status: boolean;
}

interface Pending
{
    resolve: (output: ToolOutput) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    asked: boolean;
    pinned: string;
}

const EXTENSION_WAIT = 5000;
// an extension that's switched on retries every 2 s, or every 30 s after its worker restarts
const REJECTION_MEMORY = 45_000;
const REJECTED_RETRY = 2000;
const IDLE_CHECK = 30_000;
const EXTENSION_ORIGIN = /^(chrome|moz)-extension:\/\//;
const ID = /^[\w-]{8,64}$/;
const validId = (value: unknown) => ID.test(String(value)) ? String(value) : "default";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const recency = (browser: Browser) => browser.focused ? Infinity : browser.focused_at;
const MAX_CLAIMS = 50;
const text = (value: unknown, limit: number) => typeof value === "string" ? value.slice(0, limit) : "";
const projectFrom = (value: any) => value && typeof value === "object" ? Browsers.projectOf(value.path) : null;
const display = (agent: string, project: Project | null) => project ? `${agent} in ${project.name}` : agent;
export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

// every agent session runs its own process, but each browser connects once: the first to bind the port relays for the rest
export class Bridge
{
    private role: "hub" | "peer" | null = null;
    private server: WebSocketServer | null = null;
    private browsers = new Map<string, Browser>();
    private approvals = new Set<WebSocket>();
    private hub: WebSocket | null = null;
    private peers = new Map<WebSocket, Peer>();
    private pending = new Map<string, Pending>();
    private routes = new Map<string, Route>();
    // kept by the session, not the hub, so they survive a hub takeover
    private pinned = "";
    private asked = false;
    private session = randomUUID();
    private project = Browsers.projectOf(process.cwd());
    private seq = 0;
    private closed = false;
    private dormant = false;
    private lastActive = Date.now();
    private idleTimer: NodeJS.Timeout | null = null;
    private extensionOutdatedAt = 0;
    private peerProblem = "";
    private keyProblem = "";

    constructor(private options: BridgeOptions) {}

    // election can wait indefinitely on a hub that refuses this session, so the MCP side starts without it
    start()
    {
        try { loadKey(); }
        catch (error)
        {
            // without a key this session could only block the port for the sessions that have one
            this.keyProblem = (error as Error).message;
            return this.options.log(this.keyProblem);
        }
        this.idleTimer = setInterval(() => this.releaseIfIdle(), Math.min(IDLE_CHECK, this.options.releaseAfter / 4));
        this.idleTimer.unref();
        this.join();
    }

    close()
    {
        this.closed = true;
        if (this.idleTimer) clearInterval(this.idleTimer);
        this.hub?.close();
        this.server?.close();
        for (const client of this.server?.clients || []) client.terminate();
    }

    get currentRole()
    {
        return this.role;
    }

    agentChanged()
    {
        if (this.role === "hub") this.pushAgents();
        else if (this.hub?.readyState === WebSocket.OPEN) this.hub.send(JSON.stringify({ type: "agent", ...this.me() }));
    }

    setProject(path: string)
    {
        this.project = Browsers.projectOf(path);
        this.agentChanged();
    }

    private me(): Peer
    {
        return { agent: this.options.agent(), session: this.session, project: this.project, configured: this.options.configured, pinned: this.pinned, asked: this.asked };
    }

    async call(tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<ToolOutput>
    {
        if (this.keyProblem) throw new Error(this.keyProblem);
        this.lastActive = Date.now();
        if (this.dormant)
        {
            this.dormant = false;
            this.join();
        }
        for (let i = 0; i < 100 && !this.role && !this.peerProblem; i++) await sleep(20);
        if (!this.role) throw new Error(this.peerProblem || NOT_CONNECTED);

        const id = `${this.options.name}:${++this.seq}`;
        const { browser, ...rest } = args;
        const requested = typeof browser === "string" ? browser.trim() : "";
        // held by id, since its tab ids mean nothing in another browser, even one that takes its name
        const named = requested || (this.asked ? this.pinned : "") || this.options.configured;
        const message: CallMessage = {
            type: "call",
            id,
            tool,
            args: rest,
            ...(this.pinned ? { pinned: this.pinned } : {}),
            ...(named ? { named, named_by: requested || this.asked ? "argument" : "config" } : {}),
        };
        const result = new Promise<ToolOutput>((resolve, reject) =>
        {
            const timer = setTimeout(() =>
            {
                this.pending.delete(id);
                reject(new Error(`Hoverify didn't answer within ${Math.round(timeoutMs / 1000)} seconds`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer, asked: !!requested, pinned: this.pinned });
        });

        try
        {
            if (this.role === "hub") await this.forward(message, null, this.me());
            else this.hub!.send(JSON.stringify(message));
        }
        catch (error)
        {
            this.settle({ type: "result", id, ok: false, error: (error as Error).message });
        }
        return result;
    }

    private settle(message: ResultMessage)
    {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        this.lastActive = Date.now();
        clearTimeout(pending.timer);
        const claimed = message.picked === "claim" && !!this.pinned && message.browser !== this.pinned;
        const asked = this.asked || pending.asked;
        // a call sent before the pin moved finishes late with parallel tool calls, and mustn't move it back
        const fresh = pending.asked || pending.pinned === this.pinned;
        if (message.browser && fresh && (message.browser !== this.pinned || asked !== this.asked))
        {
            this.pinned = message.browser;
            this.asked = asked;
            this.agentChanged();
        }
        const notes = message.picked === "moved" ? [BROWSER_MOVED] : claimed ? [BROWSER_CLAIMED] : [];
        if (message.ok && message.output)
        {
            if (message.browsers) notes.push(Browsers.status(message.picked!, this.options.configured, this.project, message.browsers));
            const { output } = message;
            pending.resolve({ ...output, content: [...output.content, ...notes.map(text => ({ type: "text" as const, text }))] });
        }
        else
        {
            const error = message.error || "Hoverify couldn't finish the request";
            pending.reject(new Error([error, ...notes].join("\n\n")));
        }
    }

    private failAll()
    {
        for (const id of [...this.pending.keys()]) this.settle({ type: "result", id, ok: false, error: BRIDGE_RESET });
    }

    private everyone(): Peer[]
    {
        return [this.me(), ...this.peers.values()];
    }

    // names only: a browser still asking to allow the agent hasn't proved anything yet
    private agents(): string[]
    {
        return [...new Set(this.everyone().filter(peer => peer.agent).map(peer => display(peer.agent, peer.project)))];
    }

    // the hub owns name matching, so the popups get the ids a session's binding resolves to
    private sessions(): SessionInfo[]
    {
        const open = [...this.browsers.values()];
        return this.everyone().filter(peer => peer.agent).map(peer =>
        {
            const label = this.browsers.get(peer.pinned)?.label || "";
            const bound: Bound | null = peer.asked
                ? { by: "argument", name: label, ids: [peer.pinned] }
                : peer.configured ? { by: "config", name: peer.configured, ids: Browsers.matching(open, peer.configured).map(browser => browser.id) } : null;
            return { id: peer.session, agent: peer.agent, project: peer.project, bound, browser: peer.pinned, browser_label: label };
        });
    }

    private pushAgents()
    {
        const agents = this.agents();
        const toBrowsers = JSON.stringify({ type: "agents", agents, sessions: this.sessions() });
        const toApprovals = JSON.stringify({ type: "agents", agents });
        for (const browser of this.browsers.values()) if (browser.socket.readyState === WebSocket.OPEN) browser.socket.send(toBrowsers);
        for (const socket of this.approvals) if (socket.readyState === WebSocket.OPEN) socket.send(toApprovals);
    }

    // ties go to the browser connected longest, since the map keeps connection order
    private latest(browsers: Browser[]): Browser | undefined
    {
        let best: Browser | undefined;
        for (const browser of browsers) if (!best || recency(browser) > recency(best)) best = browser;
        return best;
    }

    private accepts(browser: Browser, project: Project | null): boolean
    {
        return !browser.only || (!!project && browser.claims.includes(project.path));
    }

    private list(current = ""): BrowserInfo[]
    {
        return [...this.browsers.values()]
            .sort((a, b) => recency(b) - recency(a))
            .map(browser => ({ id: browser.id, label: browser.label, current: browser.id === current }));
    }

    private lastUsed(project: Project | null, picked: "last_used" | "moved"): { browser: Browser, picked: Picked }
    {
        const browser = this.latest([...this.browsers.values()].filter(other => this.accepts(other, project)));
        if (!browser) throw new Error(Browsers.allRefused(project, this.list()));
        return { browser, picked };
    }

    private pick(message: CallMessage, project: Project | null): { browser: Browser, picked: Picked } | null
    {
        const open = [...this.browsers.values()];
        if (message.named)
        {
            const matches = Browsers.matching(open, message.named);
            if (matches.length > 1) throw new Error(Browsers.ambiguous(message.named, matches));
            if (!matches.length) return null;
            if (!this.accepts(matches[0], project)) throw new Error(Browsers.refused(matches[0].label, project));
            return { browser: matches[0], picked: message.named_by === "config" ? "config" : "argument" };
        }
        const claimed = project ? this.latest(open.filter(browser => browser.claims.includes(project.path))) : undefined;
        if (claimed) return { browser: claimed, picked: "claim" };
        if (message.pinned)
        {
            const pinned = this.browsers.get(message.pinned);
            if (!pinned) return null;
            return this.accepts(pinned, project) ? { browser: pinned, picked: "pinned" } : this.lastUsed(project, "moved");
        }
        return open.length ? this.lastUsed(project, "last_used") : null;
    }

    // a named browser is never swapped for another, which has other logins; a session's own browser gets the whole wait before it moves
    private async target(message: CallMessage, project: Project | null): Promise<{ browser: Browser, picked: Picked }>
    {
        const until = Date.now() + EXTENSION_WAIT;
        for (;;)
        {
            const found = this.pick(message, project);
            if (found) return found;
            if (!this.browsers.size && Date.now() - this.extensionOutdatedAt < REJECTION_MEMORY) throw new Error(EXTENSION_VERSION);
            if (Date.now() >= until) break;
            await sleep(50);
        }
        if (!this.browsers.size) throw new Error(this.approvals.size ? APPROVAL_NEEDED : NOT_CONNECTED);
        if (message.named)
        {
            // a held browser is known only by an id the user never sees
            const held = message.named_by === "argument" && message.named === message.pinned;
            throw new Error(Browsers.missing(held ? `The browser this session was asked to use (id ${Browsers.shortId(message.named)})` : message.named, this.list()));
        }
        return this.lastUsed(project, "moved");
    }

    // the session comes from the socket the call arrived on, never from the call
    private async forward(message: CallMessage, peer: WebSocket | null, caller: Peer)
    {
        const { pinned, named, named_by, ...call } = message;
        call.session = caller.session;
        const { browser: target, picked } = await this.target(message, caller.project);
        this.routes.set(message.id, { peer, socket: target.socket, picked, status: message.tool === "get_status" });
        target.socket.send(JSON.stringify(call));
    }

    private join()
    {
        this.elect().catch(error => this.options.log(`can't listen on port ${this.options.port}: ${(error as Error).message}`));
    }

    private releaseIfIdle()
    {
        if (!this.role || this.pending.size || Date.now() - this.lastActive < this.options.releaseAfter) return;
        if (this.role === "hub")
        {
            if (this.server?.clients.size) return;
            this.server?.close();
            this.server = null;
        }
        else
        {
            // an idle peer would otherwise take the port back the moment the hub lets go
            const hub = this.hub;
            this.hub = null;
            hub?.close();
        }
        this.options.log(this.role === "hub" ? "idle, released the port" : "idle, left the hub");
        this.role = null;
        this.dormant = true;
    }

    private async elect()
    {
        // a random delay spreads the survivors so one wins the port cleanly
        await sleep(Math.random() * 150);
        while (!this.closed)
        {
            if (await this.becomeHub()) return;
            if (await this.becomePeer()) return;
            await sleep(this.peerProblem ? REJECTED_RETRY : 100);
        }
    }

    private becomeHub(): Promise<boolean>
    {
        return new Promise((resolve, reject) =>
        {
            const server = new WebSocketServer({ host: "127.0.0.1", port: this.options.port, maxPayload: 64 * 1024 * 1024 });
            server.once("listening", () =>
            {
                this.server = server;
                this.role = "hub";
                this.peerProblem = "";
                this.lastActive = Date.now();
                this.options.log("listening for Hoverify");
                resolve(true);
            });
            server.once("error", (error: NodeJS.ErrnoException) =>
            {
                if (error.code === "EADDRINUSE") resolve(false);
                else reject(error);
            });
            server.on("connection", (socket, request) => this.onConnection(socket, request));
        });
    }

    private becomePeer(): Promise<boolean>
    {
        return new Promise(resolve =>
        {
            let key: string;
            try { key = loadKey(); }
            catch { return resolve(false); }

            const mine = nonce();
            let proven = false;
            const socket = new WebSocket(`ws://127.0.0.1:${this.options.port}`, { maxPayload: 64 * 1024 * 1024 });
            // a hub that neither welcomes nor refuses is treated as gone
            const unanswered = setTimeout(() => socket.terminate(), 2000);
            // the session's project folder waits for the hub's proof, so whatever squats the port never learns it
            socket.once("open", () => socket.send(JSON.stringify({ type: "hello", role: "peer", protocol: PROTOCOL, nonce: mine })));
            socket.once("error", () => resolve(false));
            socket.on("message", raw =>
            {
                let message: any;
                try { message = JSON.parse(String(raw)); }
                catch { return; }

                if (message.type === "challenge")
                {
                    // whatever holds the port without this key gets no calls from this session
                    if (!proves(message.proof, key, "hub", mine, message.nonce))
                    {
                        this.peerProblem = PEER_REJECTED;
                        return socket.close();
                    }
                    proven = true;
                    return socket.send(JSON.stringify({ type: "auth", proof: prove(key, "client", message.nonce, mine) }));
                }
                if (message.type === "welcome")
                {
                    if (message.error) return;
                    if (!proven)
                    {
                        this.peerProblem = PEER_REJECTED;
                        return socket.close();
                    }
                    clearTimeout(unanswered);
                    this.hub = socket;
                    this.role = "peer";
                    this.peerProblem = "";
                    this.agentChanged();
                    return resolve(true);
                }
                if (this.hub === socket && message.type === "result") this.settle(message);
            });
            socket.on("close", (code, reason) =>
            {
                clearTimeout(unanswered);
                if (this.hub !== socket)
                {
                    if (code === 1008 && String(reason) === "wrong key") this.peerProblem = PEER_REJECTED;
                    if (code === 1008 && String(reason).startsWith("protocol")) this.peerProblem = PEER_VERSION;
                    return resolve(false);
                }
                this.hub = null;
                this.role = null;
                this.failAll();
                if (!this.closed) this.elect();
            });
        });
    }

    private onConnection(socket: WebSocket, request: IncomingMessage)
    {
        const origin = request.headers.origin || "";
        if (/^https?:/i.test(origin)) return socket.close(1008, "web pages can't connect");

        let hello: ExtensionHello | PeerHello | null = null;
        let key = "";
        let mine = "";
        socket.on("message", raw =>
        {
            let message: any;
            try { message = JSON.parse(String(raw)); }
            catch { return socket.close(1008, "bad message"); }

            if (!hello)
            {
                const extension = message.role === "ext" && EXTENSION_ORIGIN.test(origin);
                const peer = message.role === "peer" && !origin;
                if (message.type !== "hello" || typeof message.nonce !== "string" || (!extension && !peer)) return socket.close(1008, "unknown client");
                if (message.protocol !== PROTOCOL)
                {
                    if (extension) this.extensionOutdatedAt = Date.now();
                    socket.send(JSON.stringify({ type: "welcome", protocol: PROTOCOL, error: "version" }));
                    return socket.close(1008, `protocol ${message.protocol} is not ${PROTOCOL}`);
                }
                try { key = loadKey(); }
                catch { return socket.close(1011, "no key"); }

                if (extension) this.extensionOutdatedAt = 0;
                hello = message;
                mine = nonce();
                if (extension) this.keepAlive(socket);
                return socket.send(JSON.stringify({ type: "challenge", nonce: mine, key_id: keyId(key), proof: prove(key, "hub", message.nonce, mine), agents: this.agents() }));
            }

            if (message.type === "auth")
            {
                if (!proves(message.proof, key, "client", mine, hello.nonce)) return socket.close(1008, "wrong key");
                socket.removeAllListeners("message");
                return hello.role === "ext" ? this.acceptExtension(socket, hello) : this.acceptPeer(socket);
            }
            if (hello.role !== "ext") return;
            // approval means Hoverify is asking its user; it sends pair only once they allow
            if (message.type === "approval") this.approvals.add(socket);
            if (message.type === "pair") socket.send(JSON.stringify({ type: "key", key }));
        });
        socket.on("close", () =>
        {
            this.approvals.delete(socket);
            if (hello) this.lastActive = Date.now();
        });
    }

    private keepAlive(socket: WebSocket)
    {
        const ping = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "ping" })), PING_INTERVAL);
        socket.on("close", () => clearInterval(ping));
    }

    private acceptExtension(socket: WebSocket, hello: ExtensionHello)
    {
        const id = validId(hello.browser_id);
        const earlier = this.browsers.get(id);
        // only this browser's own earlier socket makes way; re-inserting keeps the map in connection order
        this.browsers.delete(id);
        if (earlier && earlier.socket !== socket) earlier.socket.close(1000, "replaced");
        const entry: Browser = { id, socket, label: "", focused: false, focused_at: 0, claims: [], only: false };
        const update = (state: BrowserState) =>
        {
            const label = Browsers.labelOf(state.label);
            const renamed = entry.label !== label;
            entry.label = label;
            entry.focused = state.focused === true;
            entry.focused_at = Number(state.focused_at) || 0;
            entry.claims = Array.isArray(state.claims) ? state.claims.filter(path => typeof path === "string").slice(0, MAX_CLAIMS) : [];
            entry.only = state.only === true;
            if (renamed && this.browsers.get(id) === entry) this.pushAgents();
        };
        update(hello);
        this.browsers.set(id, entry);
        const name = () => `${entry.label} (${Browsers.shortId(id)})`;
        this.approvals.delete(socket);
        socket.send(JSON.stringify({ type: "welcome", protocol: PROTOCOL }));
        this.options.log(`${name()} connected (${hello.browser}, Hoverify ${hello.extension_version})`);
        // the welcome carries no lists: this push gives the new browser its own and updates the others that name it
        this.pushAgents();

        socket.on("message", raw =>
        {
            let message: any;
            try { message = JSON.parse(String(raw)); }
            catch { return; }
            if (message.type === "browser") return update(message);
            if (message.type !== "result") return;
            const route = this.routes.get(message.id);
            this.routes.delete(message.id);
            message.browser = id;
            if (route)
            {
                message.picked = route.picked;
                if (route.status) message.browsers = this.list(id);
            }
            if (route?.peer) { if (route.peer.readyState === WebSocket.OPEN) route.peer.send(JSON.stringify(message)); }
            else this.settle(message);
        });
        socket.on("close", () =>
        {
            for (const [callId, route] of this.routes)
            {
                if (route.socket !== socket) continue;
                this.routes.delete(callId);
                const reset: ResultMessage = { type: "result", id: callId, ok: false, error: BRIDGE_RESET };
                if (!route.peer) this.settle(reset);
                else if (route.peer.readyState === WebSocket.OPEN) route.peer.send(JSON.stringify(reset));
            }
            if (this.browsers.get(id)?.socket !== socket) return;
            this.browsers.delete(id);
            this.options.log(`${name()} disconnected`);
            this.pushAgents();
        });
    }

    private acceptPeer(socket: WebSocket)
    {
        let caller: Peer | null = null;
        socket.send(JSON.stringify({ type: "welcome", protocol: PROTOCOL }));

        socket.on("message", raw =>
        {
            let message: any;
            try { message = JSON.parse(String(raw)); }
            catch { return; }
            if (message.type === "call")
            {
                // until the peer reports, the hub knows neither its session nor its project, so nothing can route the call
                if (!caller) return socket.close(1008, "call before agent");
                this.relay(socket, message, caller);
            }
            if (message.type === "agent")
            {
                caller = {
                    agent: text(message.agent, 100),
                    // named once, so a later report can't take over another session's tabs
                    session: caller?.session ?? validId(message.session),
                    project: projectFrom(message.project),
                    configured: text(message.configured, 100),
                    pinned: text(message.pinned, 64),
                    asked: message.asked === true,
                };
                this.peers.set(socket, caller);
                this.pushAgents();
            }
        });
        socket.on("close", () =>
        {
            if (this.peers.delete(socket)) this.pushAgents();
        });
    }

    private relay(peer: WebSocket, message: CallMessage, caller: Peer)
    {
        this.forward(message, peer, caller).catch(error =>
        {
            this.routes.delete(message.id);
            if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: "result", id: message.id, ok: false, error: (error as Error).message }));
        });
    }
}
