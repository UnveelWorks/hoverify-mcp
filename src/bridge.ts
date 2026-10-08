import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import {
    PROTOCOL,
    PING_INTERVAL,
    NOT_CONNECTED,
    MISSING_TOKEN,
    TOKEN_MISMATCH,
    PEER_REJECTED,
    BRIDGE_RESET,
    CallMessage,
    ResultMessage,
    ExtensionHello,
    ToolOutput,
} from "./protocol.js";

export interface BridgeOptions
{
    port: number;
    token: string;
    name: string;
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

function sameToken(given: unknown, expected: string): boolean
{
    if (typeof given !== "string" || !expected) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

// every agent session runs its own process, but the browser connects once: the first to bind the port relays for the rest
export class Bridge
{
    private role: "hub" | "peer" | null = null;
    private server: WebSocketServer | null = null;
    private extension: { socket: WebSocket, hello: ExtensionHello } | null = null;
    private hub: WebSocket | null = null;
    private pending = new Map<string, Pending>();
    private routes = new Map<string, WebSocket>();
    private seq = 0;
    private closed = false;
    private extensionRejectedAt = 0;
    private peerRejected = false;

    constructor(private options: BridgeOptions) {}

    // election can wait indefinitely on a hub that refuses this session, so the MCP side starts without it
    start()
    {
        // without a token this session could only block the port for the sessions that have one
        if (!this.options.token) return;
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

    async call(tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<ToolOutput>
    {
        if (!this.options.token) throw new Error(MISSING_TOKEN);
        for (let i = 0; i < 100 && !this.role && !this.peerRejected; i++) await sleep(20);
        if (!this.role) throw new Error(this.peerRejected ? PEER_REJECTED : NOT_CONNECTED);

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

    private async waitForExtension(): Promise<WebSocket>
    {
        const until = Date.now() + EXTENSION_WAIT;
        while (!this.extension && Date.now() < until)
        {
            if (Date.now() - this.extensionRejectedAt < REJECTION_MEMORY) throw new Error(TOKEN_MISMATCH);
            await sleep(50);
        }
        if (!this.extension) throw new Error(NOT_CONNECTED);
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
            await sleep(this.peerRejected ? REJECTED_RETRY : 100);
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
                this.peerRejected = false;
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
            const socket = new WebSocket(`ws://127.0.0.1:${this.options.port}`, { maxPayload: 64 * 1024 * 1024 });
            // a hub that neither welcomes nor refuses is treated as gone
            const unanswered = setTimeout(() => socket.terminate(), 2000);
            socket.once("open", () => socket.send(JSON.stringify({ type: "hello", role: "peer", token: this.options.token, protocol: PROTOCOL })));
            socket.once("error", () => resolve(false));
            socket.on("message", raw =>
            {
                const message = JSON.parse(String(raw));
                if (message.type !== "welcome") return this.settle(message);
                clearTimeout(unanswered);
                this.hub = socket;
                this.role = "peer";
                this.peerRejected = false;
                resolve(true);
            });
            socket.on("close", (code, reason) =>
            {
                clearTimeout(unanswered);
                if (this.hub !== socket)
                {
                    if (code === 1008 && String(reason) === "wrong token") this.peerRejected = true;
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

        let kind: "ext" | "peer" | null = null;
        socket.on("message", raw =>
        {
            let message: any;
            try { message = JSON.parse(String(raw)); }
            catch { return socket.close(1008, "bad message"); }

            if (!kind)
            {
                const extension = message.role === "ext" && EXTENSION_ORIGIN.test(origin);
                if (message.type !== "hello" || !sameToken(message.token, this.options.token))
                {
                    if (extension) this.extensionRejectedAt = Date.now();
                    return socket.close(1008, "wrong token");
                }
                if (extension) return this.acceptExtension(socket, message);
                if (message.role === "peer" && !origin)
                {
                    kind = "peer";
                    return socket.send(JSON.stringify({ type: "welcome", protocol: PROTOCOL }));
                }
                return socket.close(1008, "unknown client");
            }

            if (kind === "peer" && message.type === "call") this.relay(socket, message);
        });
    }

    private acceptExtension(socket: WebSocket, hello: ExtensionHello)
    {
        if (hello.protocol !== PROTOCOL)
        {
            socket.send(JSON.stringify({ type: "welcome", protocol: PROTOCOL, error: "version" }));
            return socket.close(1008, `protocol ${hello.protocol} is not ${PROTOCOL}`);
        }

        if (this.extension && this.extension.socket !== socket) this.extension.socket.close(1000, "replaced");
        this.extension = { socket, hello };
        this.extensionRejectedAt = 0;
        socket.removeAllListeners("message");
        socket.send(JSON.stringify({ type: "welcome", protocol: PROTOCOL, server_version: VERSION }));
        this.options.log(`${hello.browser} connected (Hoverify ${hello.extension_version})`);

        const ping = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "ping" })), PING_INTERVAL);
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
            clearInterval(ping);
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
