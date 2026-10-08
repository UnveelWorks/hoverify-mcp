import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import {
    PROTOCOL,
    PING_INTERVAL,
    NOT_CONNECTED,
    APPROVAL_NEEDED,
    PEER_REJECTED,
    PEER_VERSION,
    EXTENSION_VERSION,
    BRIDGE_RESET,
    CallMessage,
    ResultMessage,
    ExtensionHello,
    PeerHello,
    ToolOutput,
} from "./protocol.js";
import { keyId, loadKey, nonce, prove, proves } from "./key.js";

export interface BridgeOptions
{
    port: number;
    name: string;
    agent: () => string;
    log: (line: string) => void;
}

interface Pending
{
    resolve: (output: ToolOutput) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

const EXTENSION_WAIT = 5000;
// an extension that's switched on retries every 2 s, or every 30 s after its worker restarts
const REJECTION_MEMORY = 45_000;
const REJECTED_RETRY = 2000;
const EXTENSION_ORIGIN = /^(chrome|moz)-extension:\/\//;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

// every agent session runs its own process, but the browser connects once: the first to bind the port relays for the rest
export class Bridge
{
    private role: "hub" | "peer" | null = null;
    private server: WebSocketServer | null = null;
    private extension: { socket: WebSocket, hello: ExtensionHello } | null = null;
    private approval: WebSocket | null = null;
    private hub: WebSocket | null = null;
    private peers = new Map<WebSocket, string>();
    private pending = new Map<string, Pending>();
    private routes = new Map<string, WebSocket>();
    private seq = 0;
    private closed = false;
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
        this.elect().catch(error => this.options.log(`can't listen on port ${this.options.port}: ${(error as Error).message}`));
    }

    close()
    {
        this.closed = true;
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
        else if (this.hub?.readyState === WebSocket.OPEN) this.hub.send(JSON.stringify({ type: "agent", agent: this.options.agent() }));
    }

    async call(tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<ToolOutput>
    {
        if (this.keyProblem) throw new Error(this.keyProblem);
        for (let i = 0; i < 100 && !this.role && !this.peerProblem; i++) await sleep(20);
        if (!this.role) throw new Error(this.peerProblem || NOT_CONNECTED);

        const id = `${this.options.name}:${++this.seq}`;
        const message: CallMessage = { type: "call", id, tool, args };
        const result = new Promise<ToolOutput>((resolve, reject) =>
        {
            const timer = setTimeout(() =>
            {
                this.pending.delete(id);
                reject(new Error(`Hoverify didn't answer within ${Math.round(timeoutMs / 1000)} seconds`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
        });

        try
        {
            if (this.role === "hub") await this.forward(message);
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
        clearTimeout(pending.timer);
        if (message.ok && message.output) pending.resolve(message.output);
        else pending.reject(new Error(message.error || "Hoverify couldn't finish the request"));
    }

    private failAll()
    {
        for (const id of [...this.pending.keys()]) this.settle({ type: "result", id, ok: false, error: BRIDGE_RESET });
    }

    private agents(): string[]
    {
        return [...new Set([this.options.agent(), ...this.peers.values()].filter(Boolean))];
    }

    private pushAgents()
    {
        const message = JSON.stringify({ type: "agents", agents: this.agents() });
        for (const socket of [this.extension?.socket, this.approval])
        {
            if (socket?.readyState === WebSocket.OPEN) socket.send(message);
        }
    }

    private async waitForExtension(): Promise<WebSocket>
    {
        const until = Date.now() + EXTENSION_WAIT;
        while (!this.extension && Date.now() < until)
        {
            if (Date.now() - this.extensionOutdatedAt < REJECTION_MEMORY) throw new Error(EXTENSION_VERSION);
            await sleep(50);
        }
        if (!this.extension) throw new Error(this.approval ? APPROVAL_NEEDED : NOT_CONNECTED);
        return this.extension.socket;
    }

    private async forward(message: CallMessage)
    {
        const socket = await this.waitForExtension();
        socket.send(JSON.stringify(message));
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
            const socket = new WebSocket(`ws://127.0.0.1:${this.options.port}`, { maxPayload: 64 * 1024 * 1024 });
            // a hub that neither welcomes nor refuses is treated as gone
            const unanswered = setTimeout(() => socket.terminate(), 2000);
            socket.once("open", () => socket.send(JSON.stringify({ type: "hello", role: "peer", protocol: PROTOCOL, nonce: mine, agent: this.options.agent() })));
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
                    return socket.send(JSON.stringify({ type: "auth", proof: prove(key, "client", message.nonce, mine) }));
                }
                if (message.type === "welcome")
                {
                    if (message.error) return;
                    clearTimeout(unanswered);
                    this.hub = socket;
                    this.role = "peer";
                    this.peerProblem = "";
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
                return hello.role === "ext" ? this.acceptExtension(socket, hello) : this.acceptPeer(socket, hello);
            }
            if (hello.role !== "ext") return;
            // approval means Hoverify is asking its user; it sends pair only once they allow
            if (message.type === "approval") this.approval = socket;
            if (message.type === "pair") socket.send(JSON.stringify({ type: "key", key }));
        });
        socket.on("close", () =>
        {
            if (this.approval === socket) this.approval = null;
        });
    }

    private keepAlive(socket: WebSocket)
    {
        const ping = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "ping" })), PING_INTERVAL);
        socket.on("close", () => clearInterval(ping));
    }

    private acceptExtension(socket: WebSocket, hello: ExtensionHello)
    {
        if (this.extension && this.extension.socket !== socket) this.extension.socket.close(1000, "replaced");
        this.extension = { socket, hello };
        if (this.approval === socket) this.approval = null;
        socket.send(JSON.stringify({ type: "welcome", protocol: PROTOCOL, server_version: VERSION, agents: this.agents() }));
        this.options.log(`${hello.browser} connected (Hoverify ${hello.extension_version})`);

        socket.on("message", raw =>
        {
            let message: any;
            try { message = JSON.parse(String(raw)); }
            catch { return; }
            if (message.type !== "result") return;
            const peer = this.routes.get(message.id);
            this.routes.delete(message.id);
            if (peer) { if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify(message)); }
            else this.settle(message);
        });
        socket.on("close", () =>
        {
            if (this.extension?.socket !== socket) return;
            this.extension = null;
            this.options.log("browser disconnected");
            for (const [id, peer] of this.routes)
            {
                if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: "result", id, ok: false, error: BRIDGE_RESET }));
            }
            this.routes.clear();
            this.failAll();
        });
    }

    private acceptPeer(socket: WebSocket, hello: PeerHello)
    {
        this.peers.set(socket, String(hello.agent || ""));
        socket.send(JSON.stringify({ type: "welcome", protocol: PROTOCOL }));
        this.pushAgents();

        socket.on("message", raw =>
        {
            let message: any;
            try { message = JSON.parse(String(raw)); }
            catch { return; }
            if (message.type === "call") this.relay(socket, message);
            if (message.type === "agent")
            {
                this.peers.set(socket, String(message.agent || ""));
                this.pushAgents();
            }
        });
        socket.on("close", () =>
        {
            this.peers.delete(socket);
            this.pushAgents();
        });
    }

    private relay(peer: WebSocket, message: CallMessage)
    {
        this.routes.set(message.id, peer);
        this.forward(message).catch(error =>
        {
            this.routes.delete(message.id);
            peer.send(JSON.stringify({ type: "result", id: message.id, ok: false, error: (error as Error).message }));
        });
    }
}
