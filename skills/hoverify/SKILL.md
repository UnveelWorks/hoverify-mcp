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

## Fixing a page

1. Run the audit that matches the request: `audit_accessibility`, `audit_seo` or `audit_geo`.
2. Work through the issues in the order given. They're ranked, and each comes with selectors and a suggested fix.
3. Find the matching code with the selectors. Generated ids and class hashes change between builds, so search for stable parts.
4. After editing, `reload_tab` (dev servers with hot reload may not need it) and run the same audit again to confirm.
5. For visual changes, `capture` the element or viewport and look at it.

Audits take a few seconds to a couple of minutes on large pages. Don't run them again unless the page changed.

## Other tools

- `inspect_element` with a selector returns the element's HTML, the authored CSS rules with their stylesheet URLs, custom properties and box metrics. Use it before changing styles so you edit the rule that wins.
- `get_selected_element` returns the element the user pinned or is hovering in the Hoverify inspector. Use it when they say "this element" or "the one I selected".
- `get_site_stack` lists frameworks, libraries, hosting, DNS and SSL. It's context, not a fix list.
- `capture` returns a preview image plus the path of the full-resolution PNG, which you can attach or compare.

## Notes

- Output is Markdown written for you. Pass `format: "json"` only when you need raw data.
- `audit_geo` with `ai: true` adds an AI content review. It's slower and uses the model key the user set in Hoverify, so only run it when asked.
- In Chrome a screenshot needs the tab on screen. If capture says the tab never became visible, ask the user to bring the browser window forward.
