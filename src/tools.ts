import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { Bridge } from "./bridge.js";
import { BRIDGE_RESET, Content, ToolOutput } from "./protocol.js";

// the extension's catalog; the user's own devices are checked there
const DEVICE_IDS = ["iphone_duo", "iphone_18_pro_max", "iphone_18_pro", "iphone_17_pro_max", "iphone_17_pro", "iphone_17", "iphone_air", "iphone_17e", "iphone_16", "iphone_16_plus", "iphone_se_3", "galaxy_s26_ultra", "galaxy_s26", "galaxy_a17_5g", "galaxy_a07", "pixel_11", "pixel_11_pro_xl", "redmi_note_14_4g", "moto_g_power_2025", "galaxy_z_fold7", "galaxy_z_flip8", "pixel_10_pro_fold", "ipad_pro_13_m5", "ipad_pro_11_m5", "ipad_air_13_m4", "ipad_a16", "ipad_mini_a17_pro", "galaxy_tab_s11", "ipad", "tailwind_sm", "tailwind_md", "tailwind_lg", "tailwind_xl", "tailwind_2xl"];
const tabId = z.number().int().optional().describe("Tab to use. Defaults to the tab the user is viewing. Tabs you opened with open_url can be used too.");
const format = z.enum(["markdown", "json"]).optional().describe("markdown (default) is a ranked fix list written for you; json is the raw result.");
const browser = z.string().optional().describe("Only when Hoverify is on in more than one browser: which one to use, by the name or id get_status lists. The session stays in it afterwards. Leave it out to keep using this session's browser.");
const assetTypes = z.array(z.enum(["image", "svg", "video", "lottie", "pdf", "favicon"])).optional().describe("Only these kinds of asset");

const DESIGN_SIZES = [
    "auto", "web_open_graph", "instagram_post", "instagram_portrait", "instagram_story", "facebook_news_feed", "facebook_story", "facebook_cover_photo",
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
const DESIGN_LAYOUTS = [
    "centered", "roomy", "hero_bleed", "corner_peek", "tilted", "diagonal", "isometric", "close_up", "flat_lay", "side_wall", "tumble", "iso_close_up", "steep_corner",
    "pair", "pair_staggered", "pair_cascade", "pair_fan", "pair_tilted", "pair_iso", "trio", "trio_staggered", "trio_cascade", "trio_fan", "trio_tilted", "trio_iso", "devices",
] as const;
const DESIGN_DEVICES = [
    "iphone_duo_closed", "iphone_duo_open", "iphone_18_pro_max", "iphone_18_pro", "iphone_17_pro_max", "iphone_17_pro", "iphone_17", "iphone_air",
    "iphone_17e", "iphone_16", "iphone_16_plus", "iphone_se_3", "galaxy_s26_ultra", "galaxy_s26", "galaxy_a17_5g", "galaxy_a07", "pixel_11",
    "pixel_11_pro_xl", "redmi_note_14_4g", "moto_g_power_2025", "galaxy_z_fold7_closed", "galaxy_z_fold7_open", "galaxy_z_flip8",
    "pixel_10_pro_fold_closed", "pixel_10_pro_fold_open", "ipad_pro_13_m5", "ipad_pro_11_m5", "ipad_air_13_m4", "ipad_a16", "ipad_mini_a17_pro", "galaxy_tab_s11",
] as const;
const step = z.enum(["none", "small", "medium", "large"]);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const hexAlpha = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/).describe("#rrggbb, or #rrggbbaa with alpha");
const WEIGHTS = ["thin", "light", "regular", "medium", "semibold", "bold", "extrabold", "black"] as const;
const percent = z.number().min(0).max(100);
const rect = z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() });
const ANCHORS = ["top_left", "top", "top_right", "left", "center", "right", "bottom_left", "bottom", "bottom_right"] as const;
const pct = z.number().min(-50).max(150);
const artPct = z.number().min(-100).max(200);
const annotations = z.array(z.object({
    type: z.enum(["box", "circle", "arrow", "label", "text", "number", "blur", "spotlight", "details", "underline", "highlight", "magnifier", "image", "shape"]).describe("Pointing at the page: box, circle and arrow point something out; label is a callout with a pointer; number is a numbered step; underline, highlight and magnifier mark text or zoom into a small element; blur hides it; spotlight dims everything else; details shows its size, spacing, font and colours. Designing the canvas (with at): text, image (a logo or picture from path or url) and shape (a rect, pill, ellipse or line for colour blocks, badges and dividers). Without at, text is a caption above the shot."),
    selector: z.string().optional().describe("CSS selector of the element on the captured page"),
    rect: rect.optional().describe("Instead of a selector: CSS pixels in the screenshot; when a capture comes in several images, from the top of the first"),
    side: z.enum(["left", "right", "above", "below"]).optional().describe("Label and arrow: which side of the element they go, instead of the side with the most room"),
    at: z.object({
        anchor: z.enum(ANCHORS).optional().describe("One of nine canvas points; several at one anchor stack in order and shrink together to fit beside the shots"),
        margin: step.optional().describe("With anchor: space from the edge. Default medium."),
        x: pct.optional().describe("Free placement: percent across the canvas (0 left, 100 right; beyond bleeds off)"),
        y: pct.optional().describe("Free placement: percent down the canvas"),
        origin: z.enum(ANCHORS).optional().describe("With x and y: which point of the element sits there. Default top_left; center centres it."),
    }).optional().describe("Place text, an image or a shape on the canvas: an anchor (with margin), or x and y for exactly where you want it. Canvas elements draw above the shots, in the order listed."),
    to: z.object({ x: pct, y: pct }).optional().describe("A line shape: where it ends, in canvas percents; it starts at at.x, at.y"),
    text: z.string().max(300).optional().describe("The words, for label and text; text on the canvas can break lines with \\n"),
    role: z.enum(["eyebrow", "headline", "subtitle", "body", "caption"]).optional().describe("Canvas text: a starting size, weight and spacing scaled to the canvas. Default body."),
    font: z.string().optional().describe("Canvas text: a Google font family, Inter, Noto Sans, Nunito or Source Code Pro, or site_heading / site_body for the page's own fonts"),
    font_size: z.number().min(4).max(1000).optional().describe("Canvas text: size in px at the canvas's own size (a 2400×1350 canvas is 2400 px wide), over the role's"),
    weight: z.enum(WEIGHTS).optional(),
    line_height: z.number().min(0.7).max(3).optional().describe("Canvas text: a multiple of the font size"),
    letter_spacing: z.number().min(-100).max(200).optional().describe("Canvas text: px, negative to tighten"),
    width: z.union([z.enum(["narrow", "half", "wide"]), z.number().min(0.1).max(200)]).optional().describe("Canvas text: where it wraps (narrow, half, wide, or a percent of the canvas width). Image: its width as a percent of the canvas. Shape: its width as a percent of the canvas."),
    height: z.number().min(0.1).max(200).optional().describe("Shape: its height as a percent of the canvas height"),
    align: z.enum(["left", "center", "right"]).optional().describe("Canvas text: defaults to the anchor's side"),
    background: hex.optional().describe("Canvas text: a solid badge behind the words, sized to them"),
    radius: z.number().min(0).max(2000).optional().describe("Badge or rect corner radius in px; a badge defaults to a pill"),
    shape: z.enum(["rect", "pill", "ellipse", "line"]).optional(),
    fill: hex.optional().describe("Shape fill"),
    stroke: hex.optional().describe("Shape outline, or a line's colour"),
    stroke_width: z.number().min(0).max(200).optional().describe("Shape outline or line width in px"),
    rotation: z.number().min(-180).max(180).optional().describe("Canvas element: degrees"),
    opacity: z.number().min(0).max(100).optional().describe("Canvas element: percent"),
    path: z.string().optional().describe("Image: a PNG, JPEG, WebP, GIF or SVG file on this machine, up to 5 MB"),
    url: z.string().optional().describe("Image: an http or https address of a picture, fetched without the user's cookies, up to 5 MB"),
    color: z.union([hex, z.literal("auto")]).optional().describe("#rrggbb; defaults to the user's annotation colour. Canvas text defaults to auto: white or near-black, whichever reads best on what's behind it."),
    size: z.enum(["s", "m", "l"]).optional().describe("s, m (default) or l: stroke, text and marker size; for an image with at and no width, its height"),
    follow_shot: z.boolean().optional().describe("design_screenshot on a tilted shot: true draws it into the shot so it turns with the page; false keeps it flat on top. Pointing marks default to true, text to false; canvas elements always stay flat."),
})).max(40);
const art = z.array(z.object({
    type: z.enum(["glow", "gradient", "pattern", "shape", "text", "image", "grain"]).describe("glow: a soft light, centred on at. gradient: colors across its box, linear, radial or conic. pattern: a grid, dots, lines, cross, rings or checks. shape: rect, pill, ellipse, ring, line, polygon or star. text: display type behind the shots, filled or outlined. image: a picture or photo from path or url. grain: film noise. gradient, pattern, grain and image fill the whole canvas unless given at and a size."),
    at: z.object({
        x: artPct.optional().describe("Percent across the canvas, -100 to 200; beyond 0 to 100 bleeds off"),
        y: artPct.optional().describe("Percent down the canvas, -100 to 200"),
        origin: z.enum(ANCHORS).optional().describe("Which point of the layer sits at x, y. Default top_left; a glow's is center."),
    }).optional(),
    width: z.number().min(0.1).max(400).optional().describe("Percent of the canvas width. Text: where it wraps; leave it out for no wrapping."),
    height: z.number().min(0.1).max(400).optional().describe("Percent of the canvas height. Left out, it's as many pixels as the width (a circle, a square), or a picture's own shape."),
    to: z.object({ x: artPct, y: artPct }).optional().describe("A line: where it ends, in canvas percents"),
    color: hexAlpha.optional().describe("The layer's colour: a glow's light, a pattern's marks, a shape's or text's fill"),
    colors: z.array(hexAlpha).min(2).max(8).optional().describe("A gradient instead of one colour, for a gradient layer, or to fill a shape, text or pattern"),
    gradient: z.enum(["linear", "radial", "conic"]).optional().describe("With colors. Default linear."),
    angle: z.number().min(-360).max(360).optional().describe("Linear gradient: degrees, 0 up, 90 right, 180 (default) down. Conic: where it starts. Pattern: turns its lines."),
    center: z.object({ x: percent, y: percent }).optional().describe("Radial or conic gradient, or rings: the middle, in percents of the layer's own box"),
    stops: z.array(percent).max(8).optional().describe("With colors: where each colour sits, percents along the gradient"),
    stroke: hexAlpha.optional().describe("Shape or text outline; a ring's or line's colour"),
    stroke_width: z.number().min(0).max(500).optional().describe("px"),
    radius: z.number().min(0).max(5000).optional().describe("Rect or image corner radius in px"),
    shape: z.enum(["rect", "pill", "ellipse", "ring", "line", "polygon", "star"]).optional(),
    sides: z.number().int().min(3).max(24).optional().describe("Polygon sides or star points"),
    pattern: z.enum(["grid", "dots", "lines", "cross", "rings", "checks", "scatter"]).optional().describe("scatter strews dots of varied size and brightness, for stars, dust and sparkle"),
    spacing: z.number().min(2).max(2000).optional().describe("Pattern: px between marks, on average for scatter. Default 48."),
    size: z.number().min(0.5).max(200).optional().describe("Pattern: line width or dot size in px, the largest dot for scatter (default 1.5). Grain: px per grain (default 1.5)."),
    text: z.string().max(300).optional().describe("Text: the words; \\n breaks lines"),
    font: z.string().optional().describe("Text: a Google font family, a bundled one, or site_heading / site_body"),
    weight: z.enum(WEIGHTS).optional().describe("Text: default bold"),
    font_size: z.number().min(4).max(2000).optional().describe("Text: px at the canvas's size. Default 96."),
    line_height: z.number().min(0.5).max(3).optional(),
    letter_spacing: z.number().optional().describe("Text: px, negative to tighten"),
    align: z.enum(["left", "center", "right"]).optional(),
    fit: z.enum(["cover", "contain"]).optional().describe("Image: fill its box (default) or fit inside it"),
    seed: z.number().int().min(0).max(10000).optional().describe("Grain or scatter: a different random pattern"),
    path: z.string().optional().describe("Image: a PNG, JPEG, WebP, GIF or SVG file on this machine, up to 5 MB"),
    url: z.string().optional().describe("Image: an http or https address, fetched without the user's cookies, up to 5 MB"),
    rotation: z.number().min(-360).max(360).optional().describe("Degrees, about the layer's centre"),
    opacity: z.number().min(0).max(100).optional().describe("Percent. Grain defaults to 10."),
    blend: z.enum(["normal", "multiply", "screen", "overlay", "soft_light", "hard_light", "lighten", "darken", "color_dodge", "color_burn", "difference", "exclusion"]).optional().describe("How it mixes with what's under it: screen and color_dodge light up, multiply darkens, overlay and soft_light add contrast. Grain defaults to overlay."),
    blur: z.number().min(0).max(1000).optional().describe("px of softening"),
    fade: z.enum(["none", "top", "bottom", "left", "right", "edges", "center"]).optional().describe("Fade the layer out toward a side, toward its edges (a vignette), or out of its centre"),
})).max(40);
const placement = {
    scale: z.number().min(50).max(300).optional().describe("Size in percent; 100 fits"),
    x: z.number().min(0).max(100).optional().describe("Where it sits across, 0 to 100; 50 centres it"),
    y: z.number().min(0).max(100).optional().describe("Where it sits down, 0 to 100"),
    tilt_x: z.number().min(-60).max(60).optional().describe("3D: positive leans the top back"),
    tilt_y: z.number().min(-60).max(60).optional().describe("3D: negative faces it left, positive right"),
    turn: z.number().min(-180).max(180).optional().describe("Turn in the canvas plane, degrees"),
};

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
        description: "Take a screenshot of the visible page, the whole scrollable page, one element or a rectangle of the page. Returns a preview image, the page context (URL, viewport, element) and the path of the full-resolution image. An element or area bigger than the screen, like a full page, is scrolled through and stitched, then the page is put back; it takes longer, and a tall result comes back as preview slices from top to bottom. The user's privacy settings apply: sensitive text found on the page (emails, phone and card numbers, keys, filled-in fields) is pixelated and cookie banners and chat widgets are hidden, and the result says what was hidden. Pass annotations to mark the screenshot up (boxes, arrows, labels, numbered steps, highlights, blurs and more, pointing at elements by CSS selector), drawn on the image itself with nothing around it; for a finished, styled image use design_screenshot instead.",
        schema: {
            mode: z.enum(["viewport", "full_page", "element", "area"]).optional().describe("viewport for what's on screen, full_page for the whole page, element for one whole element, area for a rectangle of the page. Leave it out when passing capture_id."),
            selector: z.string().optional().describe("CSS selector, required for element mode"),
            area: z.object({
                x: z.number(),
                y: z.number(),
                width: z.number().positive(),
                height: z.number().positive(),
            }).optional().describe("Required for area mode: CSS pixels from the top-left of the page, the same coordinates as a full_page capture. inspect_element reports viewport positions, so add the page's scroll. For one element, use element mode instead."),
            tab_id: tabId,
            raw: z.boolean().optional().describe("Skip the user's privacy settings for this capture, so hidden text and clutter show as on the page. Only when those exact pixels are what you need to check, like a form field you just changed or a cookie banner you're fixing."),
            annotations: annotations.optional().describe("Up to 40, placed inside the screenshot where there's room around each element unless you give a side; text, images and shapes can go anywhere with at. A page that comes in several images gets each annotation in the image holding its element, with numbered steps counting on across them. The result gives a capture_id to annotate the same capture again."),
            capture_id: z.string().optional().describe("Annotate an earlier annotated capture again instead of capturing again: the new annotations list replaces the old one. New selectors are looked up only if the captured tab is still on that page."),
        },
        timeout: 180_000,
        idempotent: true,
    },
    {
        name: "design_screenshot",
        description: "Make a finished, shareable image of a page, an element or the full page in Hoverify's screenshot editor, or with mode none a design with no screenshot: a background, padding, rounded corners, a shadow, a browser or device frame, tilt, and annotations pointing at elements by CSS selector. Use it for changelogs, PRs, docs and social posts. Start with only the source and maybe a size, look at the preview, then restyle by calling it again with the returned capture_id and changed choices; a restyle doesn't capture again. Unset choices take the editor's default look (medium padding, medium radius, spread shadow, a browser frame on viewport and full-page captures, the radiant_pink_peach gradient). The user's privacy settings apply: sensitive text found on the page is pixelated and cookie banners and chat widgets are hidden, and the result says what was hidden. Returns a preview, the choices used, the capture_id and the path of the full-resolution image.",
        schema: {
            mode: z.enum(["viewport", "full_page", "element", "area", "none"]).optional().describe("What to capture, as in capture; none for a design with no screenshot, only text, pictures, shapes and art, which needs a size. Leave it out when passing capture_id."),
            selector: z.string().optional().describe("CSS selector of the element to capture, for element mode"),
            area: rect.optional().describe("For area mode: CSS pixels from the top-left of the page"),
            tab_id: tabId,
            capture_id: z.string().optional().describe("Restyle an earlier design_screenshot capture instead of capturing again (kept in memory only until Hoverify restarts: your last 5 calls that captured, and any open in the screenshot editor)"),
            size: z.enum(DESIGN_SIZES).optional().describe("auto (default) hugs the shot plus padding; the others are social and marketing sizes, for example web_open_graph (1200×630, a link preview on any site), x_one_image (2400×1350) or instagram_post (1080×1080)"),
            background: z.union([
                z.enum(DESIGN_BACKGROUNDS),
                z.object({ color: hex }),
                z.object({ gradient: z.array(hex).min(2).max(6), angle: z.number().min(0).max(360).optional().describe("Degrees; default 135") }),
                z.object({
                    shader: z.enum(DESIGN_SHADERS),
                    palette: z.enum(DESIGN_PALETTES).optional(),
                    colors: z.array(hex).min(1).max(3).optional().describe("Instead of a palette: your own 1 to 3 colours, which the look builds its tones from"),
                    dark: z.boolean().optional().describe("With colors: false for the light version of the look. Default true."),
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
            ]).optional().describe("A gradient (linear_*, cosmic_* dark, radiant_* light) or image (desktop_*, earth_* photos, abstract_*) id; auto for a gradient from the shot's own colours; { color: \"#rrggbb\" }; or a WebGL shader { shader, palette } or { shader, colors }: silk, glow and pastel are soft gradients, marble, stripes and liquid are marbled bands, rays, corner-rays and soft-rays light the shot from behind, panels is a lit stage; palette \"site\" uses the captured site's brand colours. Default radiant_pink_peach."),
            effects: z.object({
                noise: percent.optional().describe("Film noise over the background; the editor's default is 35"),
                blur: z.number().min(0).max(18).optional().describe("Softens a gradient or image background, px; default 4"),
                zoom: percent.optional().describe("Scales a gradient or image background up, percent; default 2"),
            }).optional().describe("The background's own noise, blur and zoom. Art is drawn above the blur and zoom, and under the noise."),
            padding: step.optional().describe("Space around the shot. Default medium."),
            radius: step.optional().describe("The shot's corner radius. Default medium."),
            shadow: z.enum(["none", "spread", "hug"]).optional().describe("spread (default) is a wide soft lift, hug a tight one"),
            frame: z.enum(["auto", "none", "light", "dark"]).optional().describe("A browser window around the shot with the page's address. auto (default) frames viewport and full-page captures only."),
            device: z.object({
                model: z.enum(DESIGN_DEVICES),
                finish: z.string().optional().describe("A colour the model comes in; defaults to its first"),
            }).optional().describe("Put the shot in a phone or tablet frame instead of a browser frame. The device's screen must be within 30% of the shot's shape, so a wide desktop viewport usually doesn't fit: capture an element or an area of about the screen's shape (a tablet is about 1.4:1 turned sideways, a phone about 1:2.2 upright). A device that doesn't fit is skipped, and the result says what shape it needs."),
            layout: z.enum(DESIGN_LAYOUTS).optional().describe("How the shot sits on the canvas: centered (default) and roomy; hero_bleed and corner_peek scale it up and let it run off the edge; tilted turns it gently; diagonal rolls it; isometric, flat_lay, side_wall, tumble, iso_close_up and steep_corner are bold 3D angles; close_up crops into it. A layout sets the shot's own scale, so padding then only pads an auto canvas. With shots, a layout for that many: pair (default for 2), pair_staggered, pair_cascade, pair_fan, pair_tilted and pair_iso; trio (default for 3), trio_staggered, trio_cascade, trio_fan, trio_tilted and trio_iso; devices puts 3 in a desktop, tablet and phone, so give it a tablet-shaped and a phone-shaped shot."),
            mirror: z.boolean().optional().describe("Face the layout the other way round"),
            tilt: z.enum(["none", "left", "right", "back", "left_back", "right_back"]).optional().describe("Turn the shot in 3D. Default none. With a layout it replaces only the layout's tip and turn."),
            branding: z.enum(["none", "left", "center", "right"]).optional().describe("A small \"made with Hoverify\" badge. Default none; only add it if the user asks."),
            annotations: annotations.optional().describe("Up to 40: marks pointing at the main shot, placed where there's room unless you give a side, and text, images and shapes you lay out on the canvas. On a restyle, new selectors are looked up only if the captured tab is still on that page."),
            art: art.optional().describe("Up to 40 layers drawn over the background and under the shots, in order: glows, gradients, patterns, shapes, display type, photos and grain, each with its own opacity, blend, blur, fade and rotation. This is where the background's look is made. Places and sizes are canvas percents, lengths canvas px. The result's shot_box says where the shot landed."),
            shot: z.object(placement).optional().describe("Place the main shot yourself, over the layout: scale, position and 3D angle"),
            shots: z.array(z.object({
                ...placement,
                capture_id: z.string().optional().describe("A capture_id from an earlier capture or design_screenshot"),
                mode: z.enum(["viewport", "full_page", "element", "area"]).optional().describe("Or capture it now, as the main shot is"),
                selector: z.string().optional(),
                area: rect.optional(),
                tab_id: tabId,
            })).max(2).optional().describe("Up to 2 more shots beside the main one, laid out by a multi-shot layout: each a capture_id or a source to capture now, from any tab you can reach. Their sensitive text is pixelated by the user's setting. On a restyle, leave it out to keep the shots the design has; pass [] for the main shot alone."),
            format: z.enum(["png", "jpeg", "webp"]).optional().describe("Default png"),
            scale: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().describe("Pixel scale. Defaults to the capture's own in auto size, 1 for preset sizes."),
            open_in_editor: z.boolean().optional().describe("Leave the design open in Hoverify's screenshot editor so the user can keep editing it. A later call with its capture_id updates that tab in place, as one step the user can undo. Close it with close_tab."),
        },
        timeout: 180_000,
        idempotent: false,
    },
    {
        name: "capture_devices",
        description: "Screenshot a page on phones, tablets and desktop sizes through Hoverify's Responsive view. Each device loads the page fresh at its own screen size with its own browser's user agent, and the image shows the page in the device with its status and browser bars (Safari on iOS, Chrome on Android), as the Responsive view draws it. Up to 6 devices a call, captured one after another. Returns a preview per device and the full-resolution images; a viewport shot also returns a capture_id that design_screenshot can restyle. The user's privacy settings apply.",
        schema: {
            url: z.string().optional().describe("An http or https page to load on each device. Leave it out to use the page in tab_id, or in the tab the user is viewing."),
            tab_id: tabId,
            devices: z.array(z.string()).min(1).max(6).optional().describe(`Device ids, by default iphone_17_pro, ipad_pro_11_m5 and tailwind_xl. Built in: ${DEVICE_IDS.join(", ")}. A device the user added to Hoverify works by its id too.`),
            mode: z.enum(["viewport", "full_page"]).optional().describe("viewport (default): what each screen shows, in the device. full_page: the whole page at the device's width, with no device around it."),
            frame: z.boolean().optional().describe("Draw the device around the screen. Default true."),
            os_chrome: z.boolean().optional().describe("Draw the status bar and browser bars, which also leave the page less height, as on the device. Default true."),
            landscape: z.boolean().optional().describe("Turn the devices that turn. Default false."),
            unfolded: z.boolean().optional().describe("Open the foldables. Default false."),
        },
        timeout: 300_000,
        idempotent: true,
    },
    {
        name: "get_design",
        description: "Read a design the user has open in Hoverify's screenshot editor (from design_screenshot with open_in_editor), as they have it now. Returns a preview and the full-resolution image, its choices in design_screenshot's terms (size, background, padding, shot placement and the rest), which of your choices the user changed, every annotation with whose it is and where it sits, and which of yours the user deleted. Use it to see the user's edits before a restyle, then pass the choices they made to keep them. The user's privacy settings apply to the image.",
        schema: { capture_id: z.string().describe("The capture_id of a design open in the screenshot editor") },
        timeout: 90_000,
        idempotent: true,
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

const PICTURE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml" };
const MAX_PICTURE = 5 * 1024 * 1024;

// the browser can't read the agent's files, so a picture's path goes over as its bytes
function withPictures(args: Record<string, unknown>): Record<string, unknown>
{
    const out = { ...args };
    for (const key of ["annotations", "art"]) if (Array.isArray(args[key])) out[key] = (args[key] as unknown[]).map(read);
    return out;
}

function read(a: unknown): unknown
{
    if (!a || typeof a !== "object" || typeof (a as { path?: unknown }).path !== "string") return a;
    const { path, ...rest } = a as Record<string, unknown> & { path: string };
    const type = PICTURE_TYPES[extname(path).toLowerCase()];
    if (!type) throw new Error(`${path} isn't a PNG, JPEG, WebP, GIF or SVG file.`);
    let size = 0;
    try
    {
        const stat = statSync(path);
        if (!stat.isFile()) throw new Error();
        size = stat.size;
    }
    catch { throw new Error(`${path} can't be read.`); }
    if (size > MAX_PICTURE) throw new Error(`${path} is over 5 MB.`);
    return { ...rest, data: `data:${type};base64,${readFileSync(path).toString("base64")}` };
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
                args = withPictures(args);
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
