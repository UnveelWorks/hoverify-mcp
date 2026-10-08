import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge } from "./bridge.js";
import { BRIDGE_RESET, Content, ToolOutput } from "./protocol.js";

const tabId = z.number().int().optional().describe("Tab to use. Defaults to the tab the user is viewing. Tabs you opened with open_url can be used too.");
const format = z.enum(["markdown", "json"]).optional().describe("markdown (default) is a ranked fix list written for you; json is the raw result.");

interface ToolSpec
{
    name: string;
    description: string;
    schema: Record<string, z.ZodTypeAny>;
    timeout: number;
    // a reset mid-call is retried once only when the call has no side effects
    idempotent: boolean;
}

const TOOLS: ToolSpec[] = [
    {
        name: "get_status",
        description: "Check that Hoverify is connected and see which tab is active: URL, title and viewport.",
        schema: {},
        timeout: 15_000,
        idempotent: true,
    },
    {
        name: "open_url",
        description: "Open a URL in the browser for Hoverify to work on, for example a local dev server after a change. Returns the tab id to pass to other tools. Only http, https and file URLs.",
        schema: { url: z.string().describe("The URL to open") },
        timeout: 60_000,
        idempotent: false,
    },
    {
        name: "reload_tab",
        description: "Reload a tab and wait for it to finish loading, for example after changing code so the next audit sees the change.",
        schema: { tab_id: tabId },
        timeout: 60_000,
        idempotent: true,
    },
    {
        name: "audit_seo",
        description: "Run Hoverify's SEO check on a page: meta tags, headings, images, links and structured data. Returns the issues with CSS selectors and fixes.",
        schema: { tab_id: tabId, format },
        timeout: 90_000,
        idempotent: true,
    },
    {
        name: "audit_accessibility",
        description: "Run Hoverify's accessibility audit (axe-core plus Hoverify's own checks for forms, keyboard order, links and images) on a page. Returns failing rules with selectors, HTML snippets, contrast fixes and WCAG references.",
        schema: { tab_id: tabId, format },
        timeout: 150_000,
        idempotent: true,
    },
    {
        name: "audit_geo",
        description: "Score how well AI search engines and agents can read and cite a page (Hoverify's GEO check). Returns the score and the issues ranked by how much each fix should raise it.",
        schema: {
            tab_id: tabId,
            format,
            ai: z.boolean().optional().describe("Also run the AI content review. Slower, and uses the model key the user set in Hoverify."),
        },
        timeout: 300_000,
        idempotent: true,
    },
    {
        name: "get_site_stack",
        description: "Detect the page's tech stack (frameworks, libraries, analytics), hosting, DNS and SSL. Useful context before changing code.",
        schema: { tab_id: tabId, format },
        timeout: 90_000,
        idempotent: true,
    },
    {
        name: "inspect_element",
        description: "Get an element's cleaned HTML, its authored CSS rules with their stylesheet URLs, custom properties, box metrics, accessible name and ancestors.",
        schema: { selector: z.string().describe("CSS selector for the element"), tab_id: tabId, format },
        timeout: 45_000,
        idempotent: true,
    },
    {
        name: "get_selected_element",
        description: "Get the element the user pinned or is hovering in the Hoverify inspector, in the same shape as inspect_element. Use this when the user says \"this element\" or \"the one I selected\".",
        schema: { format },
        timeout: 45_000,
        idempotent: true,
    },
    {
        name: "capture",
        description: "Take a screenshot of the visible page or of one element. Returns a preview image, the page context (URL, viewport, element) and the path of the full-resolution PNG.",
        schema: {
            mode: z.enum(["viewport", "element"]).describe("viewport for what's on screen, element for one element"),
            selector: z.string().optional().describe("CSS selector, required for element mode"),
            tab_id: tabId,
        },
        timeout: 60_000,
        idempotent: true,
    },
];

function saveFiles(output: ToolOutput): Content[]
{
    if (!output.files?.length) return output.content;
    const dir = join(tmpdir(), "hoverify");
    mkdirSync(dir, { recursive: true });
    const saved = output.files.map(file =>
    {
        const path = join(dir, file.name.replace(/[^\w.-]/g, "_"));
        writeFileSync(path, Buffer.from(file.data, "base64"));
        return path;
    });
    return [...output.content, { type: "text", text: `Full-resolution PNG: ${saved.join(", ")}` }];
}

export function registerTools(server: McpServer, bridge: Bridge)
{
    for (const spec of TOOLS)
    {
        server.registerTool(spec.name, { description: spec.description, inputSchema: spec.schema }, async (args: Record<string, unknown>) =>
        {
            try
            {
                let output: ToolOutput;
                try { output = await bridge.call(spec.name, args, spec.timeout); }
                catch (error)
                {
                    if ((error as Error).message !== BRIDGE_RESET || !spec.idempotent) throw error;
                    output = await bridge.call(spec.name, args, spec.timeout);
                }
                return { content: saveFiles(output) };
            }
            catch (error)
            {
                const message = (error as Error).message === BRIDGE_RESET
                    ? "The connection to Hoverify dropped during the call. Try again."
                    : (error as Error).message;
                return { isError: true, content: [{ type: "text" as const, text: message }] };
            }
        });
    }
}

export const TOOL_NAMES = TOOLS.map(tool => tool.name);
