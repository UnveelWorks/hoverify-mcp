import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const KEY_FORMAT = /^[0-9a-f]{64}$/;

export const keyPath = () => join(process.env.HOVERIFY_HOME || join(homedir(), ".hoverify"), "agent.key");

// read on every handshake, so deleting the file starts over at the next connection
export function loadKey(): string
{
    const path = keyPath();
    try { return checked(readFileSync(path, "utf8"), path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

    // sessions often start together; linking a finished draft means none of them reads a half-written key
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const draft = `${path}.${process.pid}`;
    writeFileSync(draft, randomBytes(32).toString("hex"), { mode: 0o600 });
    try { linkSync(draft, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    finally { unlinkSync(draft); }
    return checked(readFileSync(path, "utf8"), path);
}

function checked(text: string, path: string): string
{
    const key = text.trim();
    if (!KEY_FORMAT.test(key)) throw new Error(`${path} isn't a Hoverify key. Delete it and restart the agent; Hoverify will ask you to allow it again.`);
    return key;
}

export const keyId = (key: string) => createHash("sha256").update(Buffer.from(key, "hex")).digest("hex").slice(0, 16);

export const nonce = () => randomBytes(16).toString("hex");

export const prove = (key: string, ...parts: string[]) => createHmac("sha256", Buffer.from(key, "hex")).update(parts.join("|")).digest("hex");

export function proves(given: unknown, key: string, ...parts: string[]): boolean
{
    if (typeof given !== "string") return false;
    const a = Buffer.from(given);
    const b = Buffer.from(prove(key, ...parts));
    return a.length === b.length && timingSafeEqual(a, b);
}
