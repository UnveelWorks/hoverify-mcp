# hoverify-mcp

Lets coding agents use [Hoverify](https://tryhoverify.com) in your own browser: audit a page for SEO, accessibility and AI search, inspect an element's HTML and CSS, and take screenshots. It works on logged-in pages, staging and `localhost`, because it runs in the browser you already have open.

It's a standard MCP server over stdio, so it works with any agent that runs local MCP servers: Claude Code, Codex, Cursor, VS Code, Gemini CLI, OpenCode, Grok Build, Muse Code and the others listed below.

## Requirements

- The Hoverify extension for Chrome or Firefox, signed in with an active license
- Node.js 18 or later
- An agent that runs local (stdio) MCP servers

## Setup

1. In the Hoverify popup, open **AI agent** and switch on **Connect to agent**.
2. Add the server to your agent, as shown for each agent below.
3. The first time the agent connects, the Hoverify icon shows a **!**. Click it and choose **Allow**.

You only allow once per computer: every agent on it shares the same key, so the next ones connect without asking. **Forget** on the AI agent page disconnects them all, and Hoverify asks again next time. The connection switches itself off after 30 minutes without calls.

### Add it to your agent

Every agent runs the same thing: the command `npx` with the arguments `-y hoverify-mcp`. Most agents take it in this shape:

```json
{
  "mcpServers": {
    "hoverify": {
      "command": "npx",
      "args": ["-y", "hoverify-mcp"]
    }
  }
}
```

Agents with an add command:

| Agent | Command |
|---|---|
| Claude Code | `claude mcp add hoverify -- npx -y hoverify-mcp` |
| Codex (CLI, IDE extension and app) | `codex mcp add hoverify -- npx -y hoverify-mcp` |
| Amp | `amp mcp add hoverify -- npx -y hoverify-mcp` |
| Cline CLI | `cline mcp add hoverify --yes -- npx -y hoverify-mcp` |
| Devin CLI | `devin mcp add hoverify -s user -- npx -y hoverify-mcp` |
| Factory Droid | `droid mcp add hoverify "npx -y hoverify-mcp"` |
| Gemini CLI | `gemini mcp add -s user hoverify npx -y hoverify-mcp` |
| GitHub Copilot CLI | `copilot mcp add hoverify -- npx -y hoverify-mcp` |
| Grok Build | `grok mcp add hoverify -- npx -y hoverify-mcp` |
| Kilo Code | `kilo mcp add hoverify -- npx -y hoverify-mcp` |
| OpenCode | `opencode mcp add hoverify -- npx -y hoverify-mcp` |
| Qwen Code | `qwen mcp add hoverify npx -y hoverify-mcp` |
| VS Code | `code --add-mcp '{"name":"hoverify","type":"stdio","command":"npx","args":["-y","hoverify-mcp"]}'` |

Gemini CLI starts MCP servers only in folders you've trusted, so accept its trust prompt in your project.

Agents that take the config above in a file or a settings screen:

| Agent | Where it goes |
|---|---|
| Claude Desktop | Settings > Developer > Edit Config, then restart the app |
| Antigravity | `~/.gemini/config/mcp_config.json`, or `.agents/mcp_config.json` in a project |
| Cline in VS Code | MCP Servers > Configure > Configure MCP Servers |
| Cursor | `~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project |
| Devin Desktop (formerly Windsurf) | Its MCP settings, or `devin mcp add` as above |
| JetBrains AI Assistant | Settings > Tools > AI Assistant > Model Context Protocol (MCP) > Add |
| Junie | `~/.junie/mcp/mcp.json`, or `.junie/mcp/mcp.json` in a project |
| Kiro | `~/.kiro/settings/mcp.json`, or `.kiro/settings/mcp.json` in a project |
| Warp | Settings > Agents > MCP servers > Add, or `~/.warp/.mcp.json` |

Agents with their own format:

- **OpenCode**, to share it with a project in `opencode.json` (the add command above writes your global config). Kilo Code takes the same `mcp` block in `kilo.jsonc`.

  ```json
  {
    "$schema": "https://opencode.ai/config.json",
    "mcp": {
      "hoverify": {
        "type": "local",
        "command": ["npx", "-y", "hoverify-mcp"],
        "enabled": true
      }
    }
  }
  ```

- **VS Code**, to share it with a project in `.vscode/mcp.json`:

  ```json
  {
    "servers": {
      "hoverify": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "hoverify-mcp"]
      }
    }
  }
  ```

- **Zed**, in its settings file:

  ```json
  {
    "context_servers": {
      "hoverify": {
        "command": "npx",
        "args": ["-y", "hoverify-mcp"]
      }
    }
  }
  ```

- **Muse Code**, in `~/.config/muse/settings.json`, which must keep `"schema_version": 1`:

  ```json
  {
    "schema_version": 1,
    "mcp_servers": {
      "hoverify": {
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "hoverify-mcp"]
      }
    }
  }
  ```

- **Goose**, through `goose configure` or in `~/.config/goose/config.yaml`:

  ```yaml
  extensions:
    hoverify:
      name: hoverify
      type: stdio
      cmd: npx
      args: ["-y", "hoverify-mcp"]
      enabled: true
      timeout: 300
  ```

The environment variables below (`HOVERIFY_MCP_PORT`, `HOVERIFY_HOME`, `HOVERIFY_BROWSER`) go in the server's `env` block: `environment` in OpenCode and Kilo Code, `envs` in Goose. Add commands take them as `--env NAME=value`, or `-e NAME=value` in Gemini CLI, Qwen Code and Grok Build, placed before the server's command:

```sh
codex mcp add hoverify --env HOVERIFY_MCP_PORT=48000 -- npx -y hoverify-mcp
```

Cline CLI and Devin CLI have no env flag, so add them to the config file; Cline keeps them inside the server's `transport` block. Codex and Copilot CLI don't pass your shell's variables on to the server, so set them in the config rather than in your shell.

### Teach your agent the workflow

[`skills/hoverify`](skills/hoverify) is an [Agent Skill](https://agentskills.io) that teaches the agent the audit-and-fix loop and how to design screenshots.

In Claude Code, the plugin installs the server and the skill together:

```sh
claude plugin marketplace add UnveelWorks/hoverify-mcp
claude plugin install hoverify@hoverify
```

In other agents, or in Claude Code without the plugin, copy the folder into the agent's skills folder:

| Folder | Read by |
|---|---|
| `~/.claude/skills/` | Claude Code |
| `~/.agents/skills/` | Codex, Cursor, VS Code, GitHub Copilot CLI, Gemini CLI, OpenCode, Amp, Zed, Warp, Junie, Factory Droid, Kilo Code, Devin, Grok Build, Muse Code, Goose |
| `~/.cline/skills/` | Cline |
| `~/.kiro/skills/` | Kiro |
| `~/.qwen/skills/` | Qwen Code |

```sh
git clone --depth 1 https://github.com/UnveelWorks/hoverify-mcp.git /tmp/hoverify-mcp
mkdir -p ~/.agents/skills && cp -R /tmp/hoverify-mcp/skills/hoverify ~/.agents/skills/
```

To share it with a project instead, put it in the project's `.agents/skills/`.

### More than one browser

Hoverify can be on in several browsers at once, say Chrome and Helium. Each goes by the activation name you gave it when you signed in, unless you give it another under **Browser name** on its AI agent page. Browsers built on Chromium call themselves Chrome, so this name is how agents tell them apart. Each agent session then picks a browser like this:

1. **You ask for one.** Tell the agent "do it in Helium", and it passes `browser: "helium"` to the tool. The session stays in that browser afterwards, even if it's renamed, ahead of the project's config or a browser keeping the project, until it's asked for another one. If that browser closes, calls say so instead of moving elsewhere.
2. **The project's config names one.** Add `--browser` and the name to the args in that project's MCP config, and every session in the project uses that browser:

   ```json
   "args": ["-y", "hoverify-mcp", "--browser", "Helium"]
   ```

   `HOVERIFY_BROWSER=Helium` in the environment does the same. A browser picked either way is never swapped for another: if it isn't connected, the call fails and says so.
3. **You keep the project in a browser.** The **Sessions** tab on a browser's AI agent page lists the connected agent sessions by project folder. Switch one on to keep that project there, and its sessions work in that browser from their next call. **Only kept projects** makes the browser turn every other project away, even when an agent asks for it. A project's MCP config still wins over a browser keeping it.
4. **Otherwise**, a session's first call goes to the browser you used last, and the session stays there. If that browser goes away, its next call moves to another one and says so.

`get_status` shows which browser the session uses, why, its project, and which other browsers are connected. Sessions in the same browser each reach the tab you're viewing plus only the tabs they opened.

## Tools

| Tool | What it does |
|---|---|
| `get_status` | Checks the connection and shows the active tab |
| `open_url` | Opens a URL for the agent to work on and returns its tab id |
| `reload_tab` | Reloads a tab and waits for it to load |
| `close_tab` | Closes one or all of the tabs the agent opened |
| `audit_seo` | Meta tags, headings, images, links and structured data, plus broken links (`check_links: true`) and PageSpeed Insights (`page_speed: true`) |
| `audit_accessibility` | axe-core plus Hoverify's checks, with selectors, snippets and contrast fixes |
| `audit_geo` | How well AI search can read and cite the page, with a score |
| `get_site_stack` | Frameworks, libraries, hosting, DNS and SSL |
| `inspect_element` | An element's HTML, authored CSS, custom properties and box |
| `get_selected_element` | The element you pinned or are hovering in the Hoverify inspector |
| `capture` | A screenshot of the viewport, the full page, an element or an area, with its page context, optionally marked up with annotations pointing at elements by selector |
| `design_screenshot` | A finished, shareable image made in Hoverify's screenshot editor: a background built from glows, gradients, patterns, type, photos and grain, padding, browser or device frame, tilt, annotations pointing at elements by selector, and headlines, text and logos placed on the canvas, or the same without a screenshot |
| `get_design` | Reads a design the user has open in the screenshot editor, as they have it now: a preview, its choices in `design_screenshot`'s terms, which of the agent's choices the user changed, and every annotation with whose it is and where it sits |
| `capture_devices` | The page on up to 6 phones, tablets and desktop sizes, each loaded fresh at its screen size with its own browser's user agent and shown in the device with its browser bars, as Hoverify's Responsive view draws it; or each device's full page |
| `get_fonts` | Font families with weights, sizes, where they're used and where they load from, plus fonts that didn't load |
| `get_colors` | Colour variables, the colours used for text, backgrounds and borders, and every declared colour |
| `list_assets` | Images, inline SVGs, videos, Lottie files, PDFs and the favicon, with sizes and dimensions |
| `download_assets` | Saves chosen assets from the page to local files |

Audits return a ranked fix list in Markdown by default; pass `format: "json"` for the raw result.

`capture`, `capture_devices`, `design_screenshot` and `get_design` follow your capture settings in Hoverify: with "Hide sensitive content" on, emails, phone numbers, card numbers, keys and filled-in fields found on the page are pixelated in the image before it leaves the browser, and with "Hide clutter" on, cookie banners and chat widgets are hidden while it captures. The agent can pass `raw: true` to `capture` when it needs those exact pixels, and the result then says the settings were skipped.

You can switch off individual tools, PageSpeed and the GEO AI review in the Hoverify popup, on the AI agent page. A tool that's switched off tells the agent so instead of running.

The agent can reach the tab you're viewing and tabs it opened with `open_url`, nothing else. It can close only the tabs it opened, it can download only assets that are on the page, and it can't click or type on pages.

## What leaves your machine

The server listens on `127.0.0.1` only, and it makes no network requests of its own. Web pages can't connect to it.

On first run it writes a random key to `~/.hoverify/agent.key`, readable only by you. When you allow an agent, Hoverify keeps a copy, and after that the extension and the server each prove they hold the key on every connection without sending it. A program that grabs the port can't drive your browser without Hoverify asking you first.

What the tools return goes to your agent, and from there to the agent's model provider, like anything else the agent reads. Some tools also reach outside services, the same way they do in the extension:

- `get_site_stack` looks up the page's hostname for hosting (check-host.net, or Hoverify's own server when that fails), DNS (Google Public DNS) and SSL (decoder.link).
- `audit_seo` with `check_links: true` requests every link on the page from your browser.
- `audit_seo` with `page_speed: true` sends the page's URL to Google PageSpeed Insights and the Chrome UX Report.
- `audit_geo` with `ai: true` sends the page's text to the model provider you set up in Hoverify.

Screenshots are saved as PNG files in your system's temp folder, under `hoverify/`.

## Troubleshooting

| The agent says | What to do |
|---|---|
| Hoverify isn't connected | Switch on **Connect to agent** in the popup. It switches off after 30 idle minutes and when you sign out. |
| Hoverify is asking whether to let this agent connect | Click the Hoverify icon and choose **Allow**. |
| Hoverify isn't connected, and another app already uses port 47862 | Pick a free port under **Port** on Hoverify's AI agent page, then add the server to your agent again with the snippets there. They set `HOVERIFY_MCP_PORT` to the same port. |
| Another agent session holds the connection and uses a different key file | The agents run with different home folders, so each made its own key. Set `HOVERIFY_HOME` to the same folder for all of them. |
| Helium isn't connected, or the browser this session was asked to use isn't connected | The session was asked for a browser, or its config names one, and that browser isn't connected. Switch on **Connect to agent** in it, have the agent pass `browser` to use another connected one, or check the name under **Browser name** on its AI agent page. |
| Helium only works for the projects the user keeps in it | That browser has **Only kept projects** on. Keep this project there on its **Sessions** tab, or switch the option off. |
| More than one connected browser is named Chrome | Give the browsers different names on their AI agent pages. |
| Hoverify and hoverify-mcp are different versions | Update the extension, and restart the agent so `npx` runs the latest hoverify-mcp. |
| Another agent session holds the connection to Hoverify and runs a different version of hoverify-mcp | An agent session started before an update still holds the connection. Restart your agent sessions. A newer session also takes over on its own once no browser is connected through the older one, which happens when Hoverify updates. |
| The tab never became visible | Chrome can only screenshot a tab that's on screen. Bring the browser window forward, or keep it beside your editor. |

## Running from source

Straight from GitHub, without cloning (it builds on install): in your agent's config, use the arguments `-y github:UnveelWorks/hoverify-mcp` in place of `-y hoverify-mcp`.

Or from a clone:

```sh
npm install
npm run build
npm test
```

Then point your agent at the command `node` with the argument `/path/to/hoverify-mcp/dist/index.js`.

A release bumps the version in `package.json`, `server.json` (twice), `.claude-plugin/plugin.json` and the pinned `npx` version in `.mcp.json`.
