import { basename } from "node:path";
import { homedir } from "node:os";
import { BrowserInfo, Picked, Project } from "./protocol.js";

const LABEL_LIMIT = 40;

interface Named
{
    id: string;
    label: string;
}

export const shortId = (id: string) => id.slice(0, 8);

const WINDOWS_PATH = /^(?:[A-Za-z]:(?:[\\/]|$)|\\\\)/;

const isWindows = (path: string) => WINDOWS_PATH.test(path);
const pathKey = (path: string) => isWindows(path) ? path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase() : path.replace(/\/+$/, "");

// Windows folders ignore case, and one agent hands over c:\ where another says C:\
export const samePath = (a: string, b: string) => pathKey(a) === pathKey(b);

function tidy(path: string): string
{
    if (!isWindows(path)) return path.replace(/\/+$/, "") || "/";
    const trimmed = path.replace(/[\\/]+$/, "");
    return /^[a-z]:/.test(trimmed) ? trimmed[0].toUpperCase() + trimmed.slice(1) : trimmed;
}

// a server started in a drive's root or the home folder (Claude Desktop does) has no project to speak of
export function projectOf(path: unknown): Project | null
{
    if (typeof path !== "string" || !path || path.length > 1024) return null;
    const clean = tidy(path);
    if (clean === "/" || /^[A-Za-z]:$/.test(clean) || samePath(clean, homedir())) return null;
    return { path: clean, name: basename(clean) || clean };
}

const named = (browser: Named) => `${browser.label} (id ${shortId(browser.id)})`;

export function labelOf(label: unknown): string
{
    return (typeof label === "string" && label.trim().slice(0, LABEL_LIMIT)) || "Browser";
}

// a name can look like the start of an id ("cafe"), so names come before id prefixes
export function matching<T extends Named>(browsers: T[], wanted: string): T[]
{
    const want = wanted.toLowerCase();
    const exact = browsers.filter(browser => browser.id.toLowerCase() === want);
    if (exact.length) return exact;
    const byName = browsers.filter(browser => browser.label.toLowerCase() === want);
    if (byName.length || want.length < 4) return byName;
    return browsers.filter(browser => browser.id.toLowerCase().startsWith(want));
}

export function missing(wanted: string, connected: Named[]): string
{
    const now = connected.length ? ` Connected now: ${connected.map(named).join(", ")}.` : "";
    return `${wanted} isn't connected. Switch on AI agent in Hoverify in that browser, or pass browser to use another one.${now}`;
}

export function ambiguous(wanted: string, matches: Named[]): string
{
    return `More than one connected browser is named ${wanted}: ${matches.map(named).join(", ")}. Pass one of the ids as browser, or give the browsers different names on Hoverify's AI agent page.`;
}

export function refused(label: string, project: Project | null): string
{
    return `${label} only works for the projects the user keeps in it, and ${project ? project.name : "this session's folder"} isn't one. The user can keep it there, or switch off "Only kept projects", on Hoverify's AI agent page in ${label}.`;
}

export function allRefused(project: Project | null, connected: Named[]): string
{
    return `Every connected browser (${connected.map(named).join(", ")}) only works for the projects the user keeps in it, and ${project ? project.name : "this session's folder"} isn't one. The user can keep it in one of them on Hoverify's AI agent page.`;
}

export function status(picked: Picked, configured: string, project: Project | null, browsers: BrowserInfo[]): string
{
    const current = browsers.find(browser => browser.current)!;
    const why: { [rule in Picked]: string } = {
        argument: "you asked for it with browser",
        config: `this project's MCP config sets --browser ${configured}`,
        claim: `the user keeps ${project?.name || "this project"} in it`,
        pinned: "this session has been working in it",
        last_used: "it's the browser the user used last",
        moved: "the browser this session was using isn't connected anymore",
    };
    const lines = [`Browser: ${named(current)}, because ${why[picked]}.`];
    if (project) lines.push(`Project: ${project.name} (${project.path})`);
    if (browsers.length > 1)
    {
        lines.push(`Hoverify is on in ${browsers.length} browsers, most recently used first:`);
        lines.push(...browsers.map(browser => `- ${named(browser)}${browser.current ? ", this session's" : ""}`));
        lines.push("To use another one, pass its name as browser to any tool, or its id when two share a name. The session stays there afterwards.");
    }
    return lines.join("\n");
}
