# pi-search

English | [简体中文](./README.md)

Complete web access for [pi](https://github.com/earendil-works/pi-mono) powered by a configurable OpenAI-compatible search model API + [Tavily](https://tavily.com/) + [Firecrawl](https://firecrawl.dev/).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Architecture

```
pi ──Extension──► pi-search
                    ├─ search          ───► Search API (AI Deep Search)
                    ├─ search_sources  ───► Source Cache (by session_id)
                    ├─ web_fetch       ───► Tavily Extract → Firecrawl Scrape → Direct Fetch (auto-fallback)
                    ├─ web_map         ───► Tavily Map (Site Mapping)
                    └─ search_planning ───► 6-Phase Structured Search Planning
```

## Features

- **🔍 AI Deep Search** — Search-model-powered, auto time injection, platform focus, compact output by default
- **🎛️ Search profiles** — Switch Auto / Coding Docs / Code Examples / Project Research / Academic / Fact Check in `/search-config`
- **📄 Web Fetch** — Tavily Extract → Firecrawl Scrape → Direct Fetch auto-fallback, supports `markdown/text/html/json/raw` plus lightweight metadata, preview output by default
- **🗺️ Site Mapping** — Tavily Map traverses website structure with conservative defaults
- **📋 Search Planning** — 6-phase structured planning
- **💾 Source Cache** — session_id indexed, on-demand retrieval
- **🔄 Smart Retry** — Retry-After header parsing + exponential backoff
- **⚙️ Interactive Config** — CLI menu for Search API/Tavily/Firecrawl API
- **🔍 Connection Diagnostics** — One-click test all API connectivity

## Installation

### Option 1: pi install (Recommended)

```bash
# Install from GitHub
pi install git:github.com/justhil/pi-search

# Or with specific version
pi install git:github.com/justhil/pi-search@v2.0.0
```

### Option 2: Manual Install

```bash
# Global
git clone https://github.com/justhil/pi-search.git ~/.pi/agent/extensions/pi-search/

# Project-local
git clone https://github.com/justhil/pi-search.git .pi/extensions/pi-search/
```

### Option 3: Test Run

```bash
pi -e git:github.com/justhil/pi-search
```

## Configuration

After installation, run `/search-config` in pi for interactive configuration, or set environment variables directly:

### Environment Variables

```bash
# Search API (required, OpenAI-compatible /chat/completions)
export SEARCH_API_URL="https://api.example.com/v1"
export SEARCH_API_KEY="your-api-key"
export SEARCH_MODEL="your-search-model"

# Tavily (optional, improves web_fetch and provides web_map)
export TAVILY_API_KEY="tvly-your-key"

# Firecrawl (optional, extraction fallback for web_fetch)
export FIRECRAWL_API_KEY="fc-your-key"
```

### Interactive Config

In pi, type:

```
/search-config
```

Supports: view config, set Search API/Tavily/Firecrawl API, switch model, switch search profile, test connections.

### Config File

Persisted to `~/.config/pi-search/config.json`:

```json
{
  "apiUrl": "https://api.example.com/v1",
  "apiKey": "your-api-key",
  "model": "your-search-model",
  "searchProfile": "auto",
  "tavilyApiKey": "tvly-your-key",
  "firecrawlApiKey": "fc-your-key"
}
```

## Usage

### Commands

| Command | Description |
| ------- | ----------- |
| `/search <query>` | Search the web |
| `/search-config` | Interactive configuration |
| `/search-model [model-id]` | Switch search model |
| `/pi-ext-docs [topic]` | Search pi Extension docs |

### Tools (Auto-invoked by LLM)

| Tool | Description |
| ---- | ----------- |
| `search` | AI search with compact default output + session_id |
| `search_sources` | Retrieve paginated source list by session_id |
| `web_fetch` | Fetch web content preview (Tavily → Firecrawl → direct fallback, multi-format) |
| `web_map` | Traverse website structure with bounded output |
| `search_config` | View / modify / test configuration |
| `search_planning` | 6-phase structured search planning |

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

`/search-config` switches the global default search profile persisted in `~/.config/pi-search/config.json`. `search` also accepts a `profile` parameter for per-call overrides.

| Profile | `profile` | Best for |
| ------- | --------- | -------- |
| Auto | `auto` | Default strategy, infer from the query |
| Coding Docs | `coding_docs` | Official docs, APIs, versions, minimal examples |
| Code Examples | `code_examples` | GitHub examples and real project usage |
| Project Research | `project_research` | README, issues, releases, changelog, project comparisons |
| Academic | `academic` | Papers, reports, DOI, author/year metadata, evidence chains |
| Fact Check | `fact_check` | Multi-source verification, conflicting evidence, confidence |

The main pi prompt only receives a lightweight hint for the active profile. Full profile prompts are injected only into Search API requests to reduce persistent context usage.

### Search Result Controls

To avoid context blow-ups, conservative budgets are enabled by default:

- `search` defaults to `mode=compact`; use `mode=deep` only for explicit deep-research requests
- `extra_sources` is a shared Tavily/Firecrawl source budget, not a per-provider multiplier
- `search_sources` supports `limit` / `offset` pagination and defaults to 20 sources per call
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

The extension keeps only lightweight search rules in the main pi prompt. Detailed rules are injected into search model requests by search profile:

- Coding profiles prefer official docs, versioned API references, GitHub source, and examples
- Academic mode prioritizes papers, academic databases, official reports, and citeable metadata
- Fact-check mode emphasizes independent sources, freshness, conflicting evidence, and confidence
- Long pages are not injected by default; prefer compact results, source lists, and targeted fetches

## Links

- [GitHub](https://github.com/justhil/pi-search)
- [pi Official Docs](https://github.com/earendil-works/pi-mono)
- [pi Extension Docs](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [OpenAI-compatible Chat Completions API](https://platform.openai.com/docs/api-reference/chat)
- [Tavily API](https://docs.tavily.com/)
- [Firecrawl API](https://docs.firecrawl.dev/)

## License

[MIT](LICENSE)
