---
name: hoverify
description: Audit, inspect and screenshot web pages in the user's own browser with the Hoverify MCP server. Use when the user asks to check a page's SEO, accessibility or AI search readiness (GEO), to look at an element they picked in Hoverify, to screenshot a page or element, or to confirm a front-end change in the browser, including on localhost, staging and logged-in pages.
---

# Hoverify

The `hoverify` MCP server drives the Hoverify extension in the user's browser. It sees what the user sees: their logged-in sessions, staging sites and local dev servers.

## Before the first call

Call `get_status` once. If it fails, its message says what the user has to do (switch on **Connect to agent**, click **Allow** in Hoverify, bring the window forward). Pass that on and stop; retrying won't help.

## Which tab

- With no `tab_id`, tools use the tab the user is viewing.
- To work on another page, `open_url` it and pass the returned `tab_id` to the other tools. Prefer this for local dev servers so you don't depend on what the user has in front.
- Only the user's current tab and tabs you opened are reachable. You can't click, type or scroll.
- When you're done, `close_tab` the tabs you opened. Leave out `tab_id` to close all of them. The user's own tabs stay open.
- If the user has Hoverify on in more than one browser, `get_status` lists them by name. When they ask for one ("check it in Helium"), pass `browser` with that name. The session stays in that browser afterwards, so pass it once. Tab ids only work in the browser that gave them.

## Fixing a page

1. Run the audit that matches the request: `audit_accessibility`, `audit_seo` or `audit_geo`.
2. Work through the issues in the order given. They're ranked, and each comes with selectors and a suggested fix.
3. Find the matching code with the selectors. Generated ids and class hashes change between builds, so search for stable parts.
4. After editing, `reload_tab` (dev servers with hot reload may not need it) and run the same audit again to confirm.
5. For visual changes, `capture` the element or viewport and look at it.
6. Close the tabs you opened with `close_tab`.

Audits take a few seconds to a couple of minutes on large pages. Don't run them again unless the page changed.

## Other tools

- `inspect_element` with a selector returns the element's HTML, the authored CSS rules with their stylesheet URLs, custom properties and box metrics. Use it before changing styles so you edit the rule that wins.
- `get_selected_element` returns the element the user pinned or is hovering in the Hoverify inspector. Use it when they say "this element" or "the one I selected".
- `get_site_stack` lists frameworks, libraries, hosting, DNS and SSL. It's context, not a fix list.
- `get_fonts` and `get_colors` give a page's type and palette: families, weights and sizes, colour variables, and the colours actually used. Use them to match an existing design.
- `list_assets` lists images, inline SVGs, videos, Lottie files, PDFs and the favicon with ids. `download_assets` saves the ones you pick (by id, or a whole kind with `types`) and returns their paths; copy them into the project from there.
- `capture` returns a preview image plus the path of the full-resolution image, which you can attach or compare. `mode: "full_page"` captures the whole scrollable page. `mode: "element"` captures a whole element, even one taller or wider than the screen, and `mode: "area"` a rectangle in page coordinates. Anything bigger than the screen is scrolled through and stitched, takes longer, and a tall result comes back as several preview images from top to bottom.
- `capture_devices` checks a page on phones, tablets and desktop sizes: each device (`iphone_17_pro`, `galaxy_s26`, `ipad_pro_11_m5`, `tailwind_xl` and the rest, up to 6) loads the page fresh at its screen size with its own browser's user agent, and the image shows it in the device with its browser bars, as Hoverify's Responsive view draws it. Use it after a layout change to look for overflow, cut-off text and broken breakpoints. `mode: "full_page"` gives each device's whole page with no frame. A viewport shot's `capture_id` goes to `design_screenshot` (with `device: { model }` from the result to frame it there).

## Annotated captures

`capture` with `annotations` marks up the screenshot itself, for a bug report, a review note or a how-to step. The image stays the page, with nothing around it.

1. Point at elements by selector: `box`, `circle` or `arrow` to point, `label` for a callout with text, `number` for steps, `underline` and `highlight` for text, `magnifier` to zoom into a small element, `blur` to hide, `spotlight` to dim the rest, `details` for an element's size, spacing, font and colours. `size` is `s`, `m` or `l`.
2. Look at the preview. To change the marks, call `capture` again with the returned `capture_id` and the whole new list; it replaces the old one and the page isn't captured again.
3. A page too tall for one image comes back as several, each with the annotations whose element starts in it, and steps keep counting across them.

A magnifier is a round 2× lens over the middle of its element, so use it on small things; one too close to the image's edge, or over hidden content, is skipped and the result says why. `text` becomes a tag in the emptiest corner of the shot. To turn an annotated capture into a styled image, pass its `capture_id` to `design_screenshot`.

## Shareable screenshots

`design_screenshot` makes a finished image for a changelog, PR, doc or social post, in Hoverify's screenshot editor.

1. Start from the source alone, plus a `size` if it's for a platform (`web_open_graph` for a link preview, `x_one_image`, `instagram_post`, `linkedin_feed` …). The defaults are the editor's own look.
2. Point at what matters with `annotations` by selector: `label` for a callout with text, `box`, `circle` or `arrow` to point, `number` for steps, `spotlight` to dim the rest, `blur` to hide, `details` for an element's size, spacing, font and colours. `text` is one line above the shot.
3. Look at the preview. To change the look, call it again with the returned `capture_id` and only the choices you're changing; it reuses the capture, so the page isn't scrolled or captured again.
4. Pass `open_in_editor: true` when the user wants to keep editing it themselves. Art opens with the background (the user can remove it there); a design with no shot opens as its canvas alone. While that tab is open, every call with its `capture_id` updates it in place instead of opening another, as one step the user can undo, and waits for a drag or text edit in progress to finish. What the user draws or changes there is theirs: a later restyle rebuilds your annotations but keeps theirs, keeps their version of any of yours they changed, and leaves out any of yours they deleted (privacy redactions always stay). The result says so; to change the user's annotations, ask them. A restyle takes the canvas choices (background, size, padding, shot placement) from your recipe, so before one, call `get_design` with the `capture_id`: it shows the editor as the user has it, which of your choices they changed and where their annotations sit; pass the choices they made to keep them, and place yours around their annotations.

A device frame only fits a shot of about its screen's shape, so for a phone or tablet frame capture an element or an `area` of that shape; the result says the shape when it doesn't fit. Don't add `branding` unless the user asks.

### Designing the image

You are the designer: lay out text, pictures and shapes on the canvas, build the background, and place the shot yourself. [design-recipes.md](design-recipes.md) has eight worked examples (OG card, changelog, launch post, poster, before and after, responsive, and two with no shot) and the reasoning behind them.

- **Text:** `{ type: "text", text, at, role }`, then override any of `font_size` (px at the canvas's size), `weight`, `line_height`, `letter_spacing`, `width` (a percent of the canvas), `align`, `color` and `font` (any Google font, or `site_heading` / `site_body`). `background: "#rrggbb"` makes it a badge on a pill. Break lines with `\n`.
- **Pictures:** `{ type: "image", path or url, at, width }` for a logo or other picture.
- **Shapes:** `{ type: "shape", shape: "rect" | "pill" | "ellipse", at, width, height, fill, stroke, radius }` for colour blocks and discs, and `shape: "line"` from `at` to `to` for rules.
- **Placement:** `at: { x, y, origin }` in canvas percents puts an element exactly there (`origin: "center"` centres it on the point). `at: { anchor, margin }` is the quick alternative: elements at one anchor stack in order and shrink to fit beside the shots.
- **Every canvas element:** `rotation` (degrees) and `opacity` (percent). The list order is the layer order; annotations draw above the shots. Canvas elements are pinned to the canvas, so a user who opens the design in the editor can move or resize the shot without moving them; pointing marks move with the shot.
- **The shot:** `shot: { scale, x, y, tilt_x, tilt_y, turn }` moves, sizes and angles it over the layout; make it big and let it bleed off an edge. The result says where it landed (`The shot spans x … y …`).
- **The background:** a base (`{ color }`, `{ gradient, angle }`, a preset, or a shader with a palette or your own `colors`), then `art`: up to 40 layers drawn over it and under the shots, in order. `glow` is a soft light; `gradient` is linear, radial or conic with any colours (alpha as `#rrggbbaa`); `pattern` is a grid, dots, lines, cross, rings, checks or `scatter` (stars, dust, sparkle); `shape` adds rings, polygons and stars; `text` is display type, filled, gradient-filled or outlined; `image` is a photo or texture; `grain` is film noise. A layer can sit from -100 to 200 % of the canvas, so a huge disc shows only its rim. Every layer takes `opacity`, `blend` (`screen` to light up, `multiply` to darken, `overlay`), `blur`, `fade` (toward a side, `edges` or `center`) and `rotation`. `effects: { noise, blur, zoom }` sets the base's own effects.
- **No shot:** `mode: "none"` with a `size` makes a design from text, pictures, shapes and art alone, for a quote, stat or type poster.
- **Pointing marks** take `side` to choose where a label or arrow goes. Up to 40 annotations.

Take the brand colours from `get_colors`, use the page's own words and numbers, then look at the preview and restyle until nothing collides and there are no empty bands.

### More than one shot

Pass `shots` with up to two more: each a `capture_id` from an earlier capture or design, or a `mode` (and `tab_id`) to capture now. `layout` then picks the arrangement: `pair` or `trio` by default, or `pair_staggered`, `pair_cascade`, `pair_fan`, `pair_tilted`, `pair_iso` and their `trio_` forms; `devices` puts a desktop, tablet and phone shot side by side, so give it a tablet-shaped and a phone-shaped `area`. Annotations point at the main shot. A restyle keeps the shots unless you pass `shots` again (`[]` for the main one alone).

## Notes

- Output is Markdown written for you. Pass `format: "json"` only when you need raw data.
- `audit_geo` with `ai: true` adds an AI content review. It's slower and uses the model key the user set in Hoverify, so only run it when asked.
- `audit_seo` with `check_links: true` lists broken links and redirects. With `page_speed: true` it adds Google PageSpeed Insights, which loads the public URL from Google's servers: it can't test localhost, and it only sees changes once they're deployed.
- If a tool says it's switched off in Hoverify, the user turned it off on purpose. Don't retry it; tell them, and carry on with the tools you have.
- Screenshots follow the user's privacy settings, so emails, numbers, keys and filled-in fields may come back pixelated and banners hidden; the result says so. Pass `raw: true` to `capture` only when those exact pixels are what you're checking, and tell the user.
- In Chrome a screenshot needs the tab on screen. If capture says the tab never became visible, ask the user to bring the browser window forward.
