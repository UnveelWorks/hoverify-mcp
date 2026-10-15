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

## Shareable screenshots

`design_screenshot` makes a finished image for a changelog, PR, doc or social post, in Hoverify's screenshot editor.

1. Start from the source alone, plus a `size` if it's for a platform (`x_one_image`, `instagram_post`, `linkedin_feed` …). The defaults are the editor's own look.
2. Point at what matters with `annotations` by selector: `label` for a callout with text, `box`, `circle` or `arrow` to point, `number` for steps, `spotlight` to dim the rest, `blur` to hide, `details` for an element's size, spacing, font and colours. `text` is one line above the shot.
3. Look at the preview. To change the look, call it again with the returned `capture_id` and only the choices you're changing; it reuses the capture, so the page isn't scrolled or captured again.
4. Pass `open_in_editor: true` when the user wants to keep editing it themselves.

A device frame only fits a shot of about its screen's shape, so for a phone or tablet frame capture an element or an `area` of that shape; the result says the shape when it doesn't fit. Don't add `branding` unless the user asks.

## Notes

- Output is Markdown written for you. Pass `format: "json"` only when you need raw data.
- `audit_geo` with `ai: true` adds an AI content review. It's slower and uses the model key the user set in Hoverify, so only run it when asked.
- `audit_seo` with `check_links: true` lists broken links and redirects. With `page_speed: true` it adds Google PageSpeed Insights, which loads the public URL from Google's servers: it can't test localhost, and it only sees changes once they're deployed.
- If a tool says it's switched off in Hoverify, the user turned it off on purpose. Don't retry it; tell them, and carry on with the tools you have.
- Screenshots follow the user's privacy settings, so emails, numbers, keys and filled-in fields may come back pixelated and banners hidden; the result says so. Pass `raw: true` to `capture` only when those exact pixels are what you're checking, and tell the user.
- In Chrome a screenshot needs the tab on screen. If capture says the tab never became visible, ask the user to bring the browser window forward.
