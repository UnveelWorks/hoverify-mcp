# hoverify-mcp

Lets coding agents use [Hoverify](https://tryhoverify.com) in your own browser: audit a page for SEO, accessibility and AI search, inspect an element's HTML and CSS, and take screenshots. It works on logged-in pages, staging and `localhost`, because it runs in the browser you already have open.

It's a standard MCP server over stdio, so any MCP client can use it. Tested end to end with Claude Code.

## Requirements

- The Hoverify extension for Chrome or Firefox, signed in with an active license
- The AI agent add-on, a one-time purchase in your [Hoverify dashboard](https://dashboard.tryhoverify.com/)
- Node.js 18 or later

## Setup

1. In the Hoverify popup, open **AI agent** and switch on **Connect to agent**.
2. Copy the setup it shows into your agent. For Claude Code:

   ```sh
   claude mcp add hoverify -e HOVERIFY_TOKEN=<token> -- npx -y hoverify-mcp
   ```

   For other agents, add this to their MCP config:

   ```json
   {
     "mcpServers": {
       "hoverify": {
         "command": "npx",
         "args": ["-y", "hoverify-mcp"],
         "env": { "HOVERIFY_TOKEN": "<token>" }
       }
     }
   }
   ```

   Or, in Claude Code, install it as a plugin, which adds a skill that teaches the agent the audit-and-fix loop:

   ```sh
   claude plugin marketplace add UnveelWorks/hoverify-mcp
   claude plugin install hoverify@hoverify --config hoverify_token=<token>
   ```

The token pairs the agent with your browser. Make a new one in the popup if it leaks; that disconnects every agent using the old one. The connection switches itself off after 30 minutes without calls.

## Tools

| Tool | What it does |
|---|---|
| `get_status` | Checks the connection and shows the active tab |
| `open_url` | Opens a URL for the agent to work on and returns its tab id |
| `reload_tab` | Reloads a tab and waits for it to load |
| `audit_seo` | Meta tags, headings, images, links and structured data |
| `audit_accessibility` | axe-core plus Hoverify's checks, with selectors, snippets and contrast fixes |
| `audit_geo` | How well AI search can read and cite the page, with a score |
| `get_site_stack` | Frameworks, libraries, hosting, DNS and SSL |
| `inspect_element` | An element's HTML, authored CSS, custom properties and box |
| `get_selected_element` | The element you pinned or are hovering in the Hoverify inspector |
| `capture` | A screenshot of the viewport or an element, with its page context |

Audits return a ranked fix list in Markdown by default; pass `format: "json"` for the raw result.

The agent can reach the tab you're viewing and tabs it opened with `open_url`, nothing else. It can't click or type on pages.

## What leaves your machine

The server listens on `127.0.0.1` only and accepts the Hoverify extension holding your token. Web pages can't connect to it, and it makes no network requests of its own.

What the tools return goes to your agent, and from there to the agent's model provider, like anything else the agent reads. Two tools also reach outside services, the same way they do in the extension:

- `get_site_stack` looks up the page's hostname for hosting (check-host.net, or Hoverify's own server when that fails), DNS (Google Public DNS) and SSL (decoder.link).
- `audit_geo` with `ai: true` sends the page's text to the model provider you set up in Hoverify.

Screenshots are saved as PNG files in your system's temp folder, under `hoverify/`.

## Troubleshooting

| The agent says | What to do |
|---|---|
| Hoverify isn't connected | Switch on **Connect to agent** in the popup. It switches off after 30 idle minutes, when you sign out, and without the add-on. |
| Hoverify is trying to connect with a different token | You made a new token. Copy the setup from the popup into the agent again, then restart the agent. |
| Another agent session is running hoverify-mcp with a different HOVERIFY_TOKEN | One of your agents still has an old token. Update every agent's config, then restart them. |
| HOVERIFY_TOKEN isn't set | The agent's MCP config has no token. Copy the setup from the popup. |
| The tab never became visible | Chrome can only screenshot a tab that's on screen. Bring the browser window forward, or keep it beside your editor. |

## Running from source

```sh
npm install
npm run build
claude mcp add hoverify -e HOVERIFY_TOKEN=<token> -- node /path/to/hoverify-mcp/dist/index.js
npm test
```

A release bumps the version in `package.json`, `server.json` (twice), `.claude-plugin/plugin.json` and the pinned `npx` version in `.mcp.json`.
