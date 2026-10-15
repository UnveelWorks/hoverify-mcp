import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Bridge } from "./bridge.js";
import { BRIDGE_RESET, Content, ToolOutput } from "./protocol.js";

const tabId = z.number().int().optional().describe("Tab to use. Defaults to the tab the user is viewing. Tabs you opened with open_url can be used too.");
const format = z.enum(["markdown", "json"]).optional().describe("markdown (default) is a ranked fix list written for you; json is the raw result.");
const browser = z.string().optional().describe("Only when Hoverify is on in more than one browser: which one to use, by the name or id get_status lists. The session stays in it afterwards. Leave it out to keep using this session's browser.");
const assetTypes = z.array(z.enum(["image", "svg", "video", "lottie", "pdf", "favicon"])).optional().describe("Only these kinds of asset");

const DESIGN_SIZES = [
    "auto", "instagram_post", "instagram_portrait", "instagram_story", "facebook_news_feed", "facebook_story", "facebook_cover_photo",
    "x_one_image", "x_two_images", "x_cover_photo", "linkedin_feed", "linkedin_story", "linkedin_cover_business", "linkedin_cover_personal",
    "youtube_thumbnail", "bluesky_post", "bluesky_cover", "bluesky_cover_mobile", "product_hunt_gallery", "product_hunt_thumbnail", "dribbble_shot",
] as const;
const DESIGN_BACKGROUNDS = [
    "auto",
    "linear_navy_red_gold", "linear_purple_red_orange", "linear_deep_teal", "linear_night_purple_pink", "linear_pink_peach", "linear_plum_cream",
    "linear_soft_pink", "linear_cream_navy", "linear_sage_slate", "linear_blue_red", "linear_espresso", "linear_lavender_night",
    "cosmic_rose_dawn", "cosmic_pink_band", "cosmic_magenta_arc", "cosmic_pink_glow", "cosmic_dim_violet", "cosmic_purple_corner",
    "cosmic_violet", "cosmic_cyan_beam", "cosmic_blue_orb", "cosmic_teal_glow",
    "radiant_white_red", "radiant_indigo_rose", "radiant_blue_orange", "radiant_lavender_maroon", "radiant_coral_pink", "radiant_pink_peach",
    "radiant_white_orange", "radiant_silver_magenta", "radiant_dusk_magenta", "radiant_white_pink",
    "desktop_sunset_waves", "desktop_blue_hills", "desktop_green_hills", "desktop_teal_lines", "desktop_red_blue_waves", "desktop_neon_ribbons",
    "desktop_violet_peaks", "desktop_orange_petals", "desktop_purple_lines", "desktop_magenta_peaks",
    "earth_coast_dusk", "earth_coast_clouds", "earth_lone_tree", "earth_turquoise_shore", "earth_desert_rocks", "earth_rocks_night",
    "earth_island_blue", "earth_pink_sunset", "earth_ice_cave", "earth_night_forest", "earth_orange_haze", "earth_misty_forest", "earth_sand_dunes",
    "abstract_dark_scales", "abstract_pink_orange_flow", "abstract_blue_waves", "abstract_sandstone", "abstract_blue_pink_blur",
    "abstract_green_leaves", "abstract_green_swirls", "abstract_cream_silk", "abstract_peach_dune",
] as const;
const DESIGN_PALETTES = ["site", "shot", "indigo", "ocean", "emerald", "sunset", "rose", "daylight"] as const;
const DESIGN_SHADERS = ["silk", "glow", "pastel", "marble", "stripes", "liquid", "rays", "corner-rays", "soft-rays", "panels"] as const;
const DESIGN_PATTERNS = ["checks", "stripes", "edge"] as const;
const DESIGN_LAYOUTS = ["centered", "roomy", "hero_bleed", "corner_peek", "tilted", "diagonal", "isometric", "close_up", "flat_lay", "side_wall", "tumble", "iso_close_up", "steep_corner"] as const;
const DESIGN_DEVICES = [
    "iphone_duo_closed", "iphone_duo_open", "iphone_18_pro_max", "iphone_18_pro", "iphone_17_pro_max", "iphone_17_pro", "iphone_17", "iphone_air",
    "iphone_17e", "iphone_16", "iphone_16_plus", "iphone_se_3", "galaxy_s26_ultra", "galaxy_s26", "galaxy_a17_5g", "galaxy_a07", "pixel_11",
    "pixel_11_pro_xl", "redmi_note_14_4g", "moto_g_power_2025", "galaxy_z_fold7_closed", "galaxy_z_fold7_open", "galaxy_z_flip8",
    "pixel_10_pro_fold_closed", "pixel_10_pro_fold_open", "ipad_pro_13_m5", "ipad_pro_11_m5", "ipad_air_13_m4", "ipad_a16", "ipad_mini_a17_pro", "galaxy_tab_s11",
] as const;
const step = z.enum(["none", "small", "medium", "large"]);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const percent = z.number().min(0).max(100);
const rect = z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() });

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
        description: "Check that Hoverify is connected and see which tab is active: URL, title and viewport. With Hoverify on in more than one browser, it also lists them and says which one this session uses.",
        schema: {},
        timeout: 15_000,
        idempotent: true,
    },
    {
        name: "open_url",
        description: "Open a URL in the browser for Hoverify to work on, for example a local dev server after a change. Returns the tab id to pass to other tools. Only http, https and file URLs. Close the tab with close_tab when you're done.",
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
        name: "close_tab",
        description: "Close a tab you opened with open_url once you're done with it. Leave out tab_id to close every tab you opened. The user's own tabs can't be closed.",
        schema: { tab_id: z.number().int().optional().describe("Tab to close. Leave it out to close every tab you opened.") },
        timeout: 15_000,
        idempotent: false,
    },
    {
        name: "audit_seo",
        description: "Run Hoverify's SEO check on a page: meta tags, headings, images, links and structured data. Returns the issues with CSS selectors and fixes. Link status and PageSpeed Insights are opt-in.",
        schema: {
            tab_id: tabId,
            format,
            check_links: z.boolean().optional().describe("Also request every link on the page and list the broken ones and the redirects. Slower on pages with many links."),
            page_speed: z.boolean().optional().describe("Also run Google PageSpeed Insights for mobile and desktop: Lighthouse scores, Core Web Vitals and the slowest audits. Google's servers load the URL, so it works on public pages only and reflects what's deployed. Takes up to a minute or two."),
        },
        timeout: 300_000,
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
        name: "get_fonts",
        description: "List the fonts a page renders: each family with its weights, sizes and the elements that use it, where it loads from (Google Fonts, a web font file or the system), and declared fonts that didn't load and fell back.",
        schema: { tab_id: tabId, format },
        timeout: 60_000,
        idempotent: true,
    },
    {
        name: "get_colors",
        description: "List a page's colours: CSS variables that hold colours, the colours actually used for text, backgrounds and borders with element counts, and every colour declared in its stylesheets. Use it to match a site's palette.",
        schema: { tab_id: tabId, format },
        timeout: 90_000,
        idempotent: true,
    },
    {
        name: "list_assets",
        description: "List a page's images, inline SVGs, videos, Lottie animations, PDFs and favicon with ids, file sizes, dimensions and URLs. Pass the ids to download_assets to save the files.",
        schema: { tab_id: tabId, types: assetTypes, format },
        timeout: 90_000,
        idempotent: true,
    },
    {
        name: "download_assets",
        description: "Save assets from the page to local files and return their paths: pass ids from list_assets, or types (for example [\"svg\"]) to save every asset of those kinds. Only assets found on the page can be saved, up to 40 MB per call.",
        schema: {
            tab_id: tabId,
            ids: z.array(z.string()).optional().describe("Asset ids from list_assets"),
            types: assetTypes,
        },
        timeout: 180_000,
        idempotent: true,
    },
    {
        name: "capture",
        description: "Take a screenshot of the visible page, the whole scrollable page, one element or a rectangle of the page. Returns a preview image, the page context (URL, viewport, element) and the path of the full-resolution image. An element or area bigger than the screen, like a full page, is scrolled through and stitched, then the page is put back; it takes longer, and a tall result comes back as preview slices from top to bottom. The user's privacy settings apply: sensitive text found on the page (emails, phone and card numbers, keys, filled-in fields) is pixelated and cookie banners and chat widgets are hidden, and the result says what was hidden.",
        schema: {
            mode: z.enum(["viewport", "full_page", "element", "area"]).describe("viewport for what's on screen, full_page for the whole page, element for one whole element, area for a rectangle of the page"),
            selector: z.string().optional().describe("CSS selector, required for element mode"),
            area: z.object({
                x: z.number(),
                y: z.number(),
                width: z.number().positive(),
                height: z.number().positive(),
            }).optional().describe("Required for area mode: CSS pixels from the top-left of the page, the same coordinates as a full_page capture. inspect_element reports viewport positions, so add the page's scroll. For one element, use element mode instead."),
            tab_id: tabId,
            raw: z.boolean().optional().describe("Skip the user's privacy settings for this capture, so hidden text and clutter show as on the page. Only when those exact pixels are what you need to check, like a form field you just changed or a cookie banner you're fixing."),
        },
        timeout: 180_000,
        idempotent: true,
    },
    {
        name: "design_screenshot",
        description: "Make a finished, shareable image of a page, an element or the full page in Hoverify's screenshot editor: a background, padding, rounded corners, a shadow, a browser or device frame, tilt, and annotations pointing at elements by CSS selector. Use it for changelogs, PRs, docs and social posts. Start with only the source and maybe a size, look at the preview, then restyle by calling it again with the returned capture_id and changed choices; a restyle doesn't capture again. Unset choices take the editor's default look (medium padding, medium radius, spread shadow, a browser frame on viewport and full-page captures, the radiant_pink_peach gradient). The user's privacy settings apply: sensitive text found on the page is pixelated and cookie banners and chat widgets are hidden, and the result says what was hidden. Returns a preview, the choices used, the capture_id and the path of the full-resolution image.",
        schema: {
            mode: z.enum(["viewport", "full_page", "element", "area"]).optional().describe("What to capture, as in capture. Leave it out when passing capture_id."),
            selector: z.string().optional().describe("CSS selector of the element to capture, for element mode"),
            area: rect.optional().describe("For area mode: CSS pixels from the top-left of the page"),
            tab_id: tabId,
            capture_id: z.string().optional().describe("Restyle an earlier design_screenshot capture instead of capturing again (kept in memory only, the last 5, until Hoverify restarts)"),
            size: z.enum(DESIGN_SIZES).optional().describe("auto (default) hugs the shot plus padding; the others are social and marketing sizes, for example x_one_image (2400×1350) or instagram_post (1080×1080)"),
            background: z.union([
                z.enum(DESIGN_BACKGROUNDS),
                z.object({ color: hex }),
                z.object({
                    shader: z.enum(DESIGN_SHADERS),
                    palette: z.enum(DESIGN_PALETTES),
                    settings: z.strictObject({
                        distortion: percent.optional(),
                        swirl: percent.optional(),
                        grain: percent.optional(),
                        pattern: z.enum(DESIGN_PATTERNS).optional(),
                        softness: percent.optional(),
                        light: z.strictObject({ x: percent, y: percent }).optional(),
                        density: percent.optional(),
                        intensity: percent.optional(),
                        bloom: percent.optional(),
                        angle: z.number().min(-100).max(100).optional(),
                        length: percent.optional(),
                        blur: percent.optional(),
                    }).optional().describe("The shader's own controls as the editor's slider percents; leave out any that should keep the look's tuned value. silk, glow, pastel: distortion, swirl, grain. marble, stripes, liquid: pattern (checks | stripes | edge), distortion, swirl, softness. rays, corner-rays, soft-rays: light { x, y } (where the light sits, 0 to 100 from the canvas's top-left; 0 and 100 are just past the edge), density, intensity, bloom. panels: density, angle (-100 to 100), length, blur. A setting the chosen shader doesn't have is refused."),
                }),
            ]).optional().describe("A gradient (linear_*, cosmic_* dark, radiant_* light) or image (desktop_*, earth_* photos, abstract_*) id; auto for a gradient from the shot's own colours; { color: \"#rrggbb\" }; or a WebGL shader { shader, palette }: silk, glow and pastel are soft gradients, marble, stripes and liquid are marbled bands, rays, corner-rays and soft-rays light the shot from behind, panels is a lit stage; palette \"site\" uses the captured site's brand colours. Default radiant_pink_peach."),
            padding: step.optional().describe("Space around the shot. Default medium."),
            radius: step.optional().describe("The shot's corner radius. Default medium."),
            shadow: z.enum(["none", "spread", "hug"]).optional().describe("spread (default) is a wide soft lift, hug a tight one"),
            frame: z.enum(["auto", "none", "light", "dark"]).optional().describe("A browser window around the shot with the page's address. auto (default) frames viewport and full-page captures only."),
            device: z.object({
                model: z.enum(DESIGN_DEVICES),
                finish: z.string().optional().describe("A colour the model comes in; defaults to its first"),
            }).optional().describe("Put the shot in a phone or tablet frame instead of a browser frame. The device's screen must be within 30% of the shot's shape, so a wide desktop viewport usually doesn't fit: capture an element or an area of about the screen's shape (a tablet is about 1.4:1 turned sideways, a phone about 1:2.2 upright). A device that doesn't fit is skipped, and the result says what shape it needs."),
            layout: z.enum(DESIGN_LAYOUTS).optional().describe("How the shot sits on the canvas: centered (default) and roomy; hero_bleed and corner_peek scale it up and let it run off the edge; tilted turns it gently; diagonal rolls it; isometric, flat_lay, side_wall, tumble, iso_close_up and steep_corner are bold 3D angles; close_up crops into it. A layout sets the shot's own scale, so padding then only pads an auto canvas."),
            mirror: z.boolean().optional().describe("Face the layout the other way round"),
            tilt: z.enum(["none", "left", "right", "back", "left_back", "right_back"]).optional().describe("Turn the shot in 3D. Default none. With a layout it replaces only the layout's tip and turn."),
            branding: z.enum(["none", "left", "center", "right"]).optional().describe("A small \"made with Hoverify\" badge. Default none; only add it if the user asks."),
            annotations: z.array(z.object({
                type: z.enum(["box", "circle", "arrow", "label", "text", "number", "blur", "spotlight", "details"]).describe("box, circle and arrow point something out; label is a callout with text and a pointer; text is one line above the shot; number is a numbered step (1, 2, 3 in order); blur hides it; spotlight dims everything else; details shows the element's size, spacing, font and colours"),
                selector: z.string().optional().describe("CSS selector of the element on the captured page. Preferred."),
                rect: rect.optional().describe("Instead of a selector: CSS pixels in the screenshot"),
                text: z.string().optional().describe("The words, for label and text"),
                color: hex.optional().describe("#rrggbb; defaults to the user's annotation colour"),
                follow_shot: z.boolean().optional().describe("On a tilted shot: true draws it into the shot so it turns with the page and stays on its element; false keeps it flat on top. Defaults to true, except text, which stays flat; a blur or spotlight always follows."),
            })).max(10).optional().describe("Up to 10, placed where there's room around each element. On a restyle, new selectors are looked up only if the captured tab is still on that page."),
            format: z.enum(["png", "jpeg", "webp"]).optional().describe("Default png"),
            scale: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().describe("Pixel scale. Defaults to the capture's own in auto size, 1 for preset sizes."),
            open_in_editor: z.boolean().optional().describe("Leave the design open in Hoverify's screenshot editor so the user can keep editing it. Close it with close_tab."),
        },
        timeout: 180_000,
        idempotent: false,
    },
];

// one folder level is allowed for grouping; every segment is sanitised so nothing escapes the hoverify folder
function savePath(dir: string, name: string): string
{
    const parts = name.split("/").map(part => part.replace(/[^\w.()-]/g, "_")).filter(part => part && part !== "." && part !== "..");
    return join(dir, ...(parts.length ? parts.slice(-2) : ["file"]));
}

function saveFiles(output: ToolOutput): Content[]
{
    if (!output.files?.length) return output.content;
    const dir = join(tmpdir(), "hoverify");
    const saved = output.files.map(file =>
    {
        const path = savePath(dir, file.name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, Buffer.from(file.data, "base64"));
        return path;
    });
    const label = output.files_label || "Full-resolution image";
    const list = saved.length === 1 ? ` ${saved[0]}` : `\n${saved.map(path => `- ${path}`).join("\n")}`;
    return [...output.content, { type: "text", text: `${label}:${list}` }];
}

export function registerTools(server: McpServer, bridge: Bridge)
{
    for (const spec of TOOLS)
    {
        server.registerTool(spec.name, { description: spec.description, inputSchema: { ...spec.schema, browser } }, async (args: Record<string, unknown>) =>
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
