# pi-grok-search

English | [简体中文](./README.md)

Complete web access for [pi](https://github.com/earendil-works/pi-mono) powered by [Grok API](https://docs.x.ai/) + [Tavily](https://tavily.com/) + [Firecrawl](https://firecrawl.dev/).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> Inspired by [GrokSearch MCP](https://github.com/GuDaStudio/GrokSearch)

## Architecture

```
pi ──Extension──► pi-grok-search
                    ├─ grok_search     ───► Grok API (AI Deep Search)
                    ├─ grok_sources    ───► Source Cache (by session_id)
                    ├─ web_fetch       ───► Tavily Extract → Firecrawl Scrape → Direct Fetch (auto-fallback)
                    ├─ web_map         ───► Tavily Map (Site Mapping)
                    └─ search_planning ──► 6-Phase Structured Search Planning
```

## Features

- **🔍 AI Deep Search** — Grok-powered, auto time injection, platform focus, compact output by default
- **🎛️ Search profiles** — Switch Auto / Coding Docs / Code Examples / Project Research / Academic / Fact Check in `/grok-config`
- **📄 Web Fetch** — Tavily Extract → Firecrawl Scrape → Direct Fetch auto-fallback, supports `markdown/text/html/json/raw` plus lightweight metadata, preview output by default
- **🗺️ Site Mapping** — Tavily Map traverses website structure with conservative defaults
- **📋 Search Planning** — 6-phase structured planning
- **💾 Source Cache** — session_id indexed, on-demand retrieval
- **🔄 Smart Retry** — Retry-After header parsing + exponential backoff
- **⚙️ Interactive Config** — CLI menu for Grok/Tavily/Firecrawl API
- **🔍 Connection Diagnostics** — One-click test all API connectivity

## Installation

### Option 1: pi install (Recommended)

```bash
# Install from GitHub
pi install git:github.com/justhiL/pi-grok-search

# Or with specific version
pi install git:github.com/justhiL/pi-grok-search@v2.0.0
```

### Option 2: Manual Install

```bash
# Global
git clone https://github.com/justhiL/pi-grok-search.git ~/.pi/agent/extensions/pi-grok-search/

# Project-local
git clone https://github.com/justhiL/pi-grok-search.git .pi/extensions/pi-grok-search/
```

### Option 3: Test Run

```bash
pi -e git:github.com/justhiL/pi-grok-search
```

## Configuration

After installation, run `/grok-config` in pi for interactive configuration, or set environment variables directly:

### Environment Variables

```bash
# Grok (required)
export GROK_API_URL="https://api.x.ai/v1"
export GROK_API_KEY="xai-your-key"
export GROK_MODEL="grok-4-fast"        # optional

# Tavily (optional, improves web_fetch and provides web_map)
export TAVILY_API_KEY="tvly-your-key"

# Firecrawl (optional, extraction fallback for web_fetch)
export FIRECRAWL_API_KEY="fc-your-key"
```

### Interactive Config

In pi, type:

```
/grok-config
```

Supports: view config, set Grok/Tavily/Firecrawl API, switch model, switch search profile, test connections.

### Config File

Persisted to `~/.config/pi-grok-search/config.json`:

```json
{
  "apiUrl": "https://api.x.ai/v1",
  "apiKey": "xai-your-key",
  "model": "grok-4-fast",
  "searchProfile": "auto",
  "tavilyApiKey": "tvly-your-key",
  "firecrawlApiKey": "fc-your-key"
}
```

## Usage

### Commands

| Command                  | Description               |
| ------------------------ | ------------------------- |
| `/grok-search <query>`   | Search the web            |
| `/grok-config`           | Interactive configuration |
| `/grok-model [model-id]` | Switch Grok model         |
| `/pi-ext-docs [topic]`   | Search pi Extension docs  |

### Tools (Auto-invoked by LLM)

| Tool              | Description                                          |
| ----------------- | ---------------------------------------------------- |
| `grok_search`     | AI search with compact default output + session_id      |
| `grok_sources`    | Retrieve paginated source list by session_id            |
| `web_fetch`       | Fetch web content preview (Tavily → Firecrawl → direct fallback, multi-format) |
| `web_map`         | Traverse website structure with bounded output          |
| `grok_config`     | View / modify / test configuration                   |
| `search_planning` | 6-phase structured search planning                   |

After installation, LLM automatically recognizes these tools and decides when to call them.

### `web_fetch` vs pi-smart-fetch

[`pi-smart-fetch`](https://pi.dev/packages/pi-smart-fetch) is a dedicated fetch package focused on browser-like TLS/HTTP fingerprints, Defuddle extraction, batch fetch, attachment/large-file downloads, and site-specific cleanup.

This extension keeps `web_fetch` scoped to targeted URL previews inside a search workflow, with no extra runtime dependencies and conservative context usage:

- Default chain: `Tavily Extract` → `Firecrawl Scrape` → `direct fetch`; direct fetch only sends common browser headers and does not promise real TLS fingerprinting or JS rendering
- Formats: `markdown` (default), `text`, `html`, `json`, `raw`; `raw` is still a budgeted raw body/`rawHtml` preview, not a full response dump
- Returns `details.metadata`: URL, final URL, status, Content-Type, Content-Length, Content-Disposition, title, description, canonical URL, language, and other available fields
- direct fetch follows short-delay `<meta http-equiv="refresh">` redirects and can try qualified `<link rel="alternate" type="...">` entries when the extracted body is thin
- Detectable large or binary targets return metadata instead of injecting bodies; login sessions, CAPTCHA, JavaScript execution, and bulk downloads are out of scope

Example parameters:

```json
{
  "url": "https://example.com/docs",
  "format": "markdown",
  "max_output_bytes": 12000
}
```

### Search Profiles

`/grok-config` switches the global default search profile persisted in `~/.config/pi-grok-search/config.json`. `grok_search` also accepts a `profile` parameter for per-call overrides.

| Profile | `profile` | Best for |
| ------- | --------- | -------- |
| Auto | `auto` | Default strategy, infer from the query |
| Coding Docs | `coding_docs` | Official docs, APIs, versions, minimal examples |
| Code Examples | `code_examples` | GitHub examples and real project usage |
| Project Research | `project_research` | README, issues, releases, changelog, project comparisons |
| Academic | `academic` | Papers, reports, DOI, author/year metadata, evidence chains |
| Fact Check | `fact_check` | Multi-source verification, conflicting evidence, confidence |

The main pi prompt only receives a lightweight hint for the active profile. Full profile prompts are injected only into Grok API requests to reduce persistent context usage.

### Search Result Controls

To avoid context blow-ups, conservative budgets are enabled by default:

- `grok_search` defaults to `mode=compact`; use `mode=deep` only for explicit deep-research requests
- `extra_sources` is a shared Tavily/Firecrawl source budget, not a per-provider multiplier
- `grok_sources` supports `limit` / `offset` pagination and defaults to 20 sources per call
- `web_fetch` defaults to `format=markdown` and returns an approximately 12KB preview; it still tries direct fetch without Tavily/Firecrawl, and `format` / `max_output_bytes` can adjust one call
- `web_map` defaults to `max_breadth=10`, `limit=30`, and uses the shared output truncation path

Common parameters:

```json
{
  "profile": "auto | coding_docs | code_examples | project_research | academic | fact_check",
  "mode": "compact | normal | deep | sources_only",
  "max_answer_chars": 6000,
  "max_sources": 8,
  "max_output_bytes": 12000
}
```

## Search Quality Guidelines

The extension keeps only lightweight search rules in the main pi prompt. Detailed rules are injected into Grok requests by search profile:

- Coding profiles prefer official docs, versioned API references, GitHub source, and examples
- Academic mode prioritizes papers, academic databases, official reports, and citeable metadata
- Fact-check mode emphasizes independent sources, freshness, conflicting evidence, and confidence
- Long pages are not injected by default; prefer compact results, source lists, and targeted fetches

## Links

- [GitHub](https://github.com/justhiL/pi-grok-search)
- [pi Official Docs](https://github.com/earendil-works/pi-mono)
- [pi Extension Docs](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [Grok API](https://docs.x.ai/)
- [Tavily API](https://docs.tavily.com/)
- [Firecrawl API](https://docs.firecrawl.dev/)
- [GrokSearch MCP Reference](https://github.com/GuDaStudio/GrokSearch)

## License

[MIT](LICENSE)
