# pi-search

[English](./README_EN.md) | 简体中文

通过可配置的 OpenAI-compatible 搜索模型 API + [Tavily](https://tavily.com/) + [Firecrawl](https://firecrawl.dev/) 为 [pi](https://github.com/earendil-works/pi-mono) 提供完整的网络访问能力。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 双引擎架构

```
pi ──Extension──► pi-search
                    ├─ search          ───► Search API（AI 深度搜索）
                    ├─ search_sources  ───► 信源缓存（按 session_id）
                    ├─ web_fetch       ───► Tavily Extract → Firecrawl Scrape → Direct Fetch（自动降级）
                    ├─ web_map         ───► Tavily Map（站点映射）
                    └─ search_planning ───► 6 阶段结构化搜索规划
```

## 功能特性

- **🔍 AI 深度搜索** — 搜索模型驱动，自动时间注入，支持平台聚焦，默认紧凑输出
- **🎛️ 搜索模式预设** — `/search-config` 中切换 Auto / 编程文档 / 代码示例 / 项目调研 / 论文资料 / 事实核查
- **📄 网页抓取** — Tavily Extract → Firecrawl Scrape → Direct Fetch 自动降级，支持 `markdown/text/html/json/raw` 与轻量 metadata，默认返回预览避免上下文爆炸
- **🗺️ 站点映射** — Tavily Map 遍历网站结构，默认限制链接与输出大小
- **📋 搜索规划** — 6 阶段结构化规划
- **💾 信源缓存** — session_id 索引，按需获取
- **🔄 智能重试** — Retry-After 头解析 + 指数退避
- **⚙️ 交互式配置** — CLI 菜单配置 Search API/Tavily/Firecrawl API
- **🔍 连接诊断** — 一键测试所有 API 连通性

## 安装

### 方式一：pi install（推荐）

```bash
# 从 GitHub 安装
pi install git:github.com/justhil/pi-search

# 或指定版本
pi install git:github.com/justhil/pi-search@v2.0.0
```

### 方式二：手动安装

```bash
# 全局
git clone https://github.com/justhil/pi-search.git ~/.pi/agent/extensions/pi-search/

# 项目本地
git clone https://github.com/justhil/pi-search.git .pi/extensions/pi-search/
```

### 方式三：测试运行

```bash
pi -e git:github.com/justhil/pi-search
```

## 配置

安装后在 pi 中运行 `/search-config` 进入交互式配置菜单，或直接设置环境变量：

### 环境变量

```bash
# Search API（必填，OpenAI-compatible /chat/completions）
export SEARCH_API_URL="https://api.example.com/v1"
export SEARCH_API_KEY="your-api-key"
export SEARCH_MODEL="your-search-model"

# Tavily（可选，增强 web_fetch 并提供 web_map）
export TAVILY_API_KEY="tvly-your-key"

# Firecrawl（可选，web_fetch 提取托底）
export FIRECRAWL_API_KEY="fc-your-key"
```

### 交互式配置

在 pi 中输入：

```
/search-config
```

支持：查看配置、设置 Search API/Tavily/Firecrawl API、切换模型、切换搜索模式、测试连接。

### 配置文件

持久化到 `~/.config/pi-search/config.json`：

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

## 使用

### 命令

| 命令 | 说明 |
| ---- | ---- |
| `/search <query>` | 搜索网络信息 |
| `/search-config` | 交互式配置管理 |
| `/search-model [model-id]` | 切换搜索模型 |
| `/pi-ext-docs [topic]` | 搜索 pi Extension 开发文档 |

### 工具（LLM 自动调用）

| 工具 | 说明 |
| ---- | ---- |
| `search` | AI 深度搜索，默认 compact 输出，返回结果 + session_id |
| `search_sources` | 通过 session_id 分页获取信源列表 |
| `web_fetch` | 抓取网页内容预览（Tavily → Firecrawl → direct 自动降级，多格式） |
| `web_map` | 遍历网站结构，生成受限站点地图 |
| `search_config` | 查看/修改/测试配置 |
| `search_planning` | 6 阶段结构化搜索规划 |

安装后 LLM 会自动识别这些工具，根据用户问题自主决定调用。

### `web_fetch` 与 pi-smart-fetch 的差异

[`pi-smart-fetch`](https://pi.dev/packages/pi-smart-fetch) 是专门的抓取插件，重点在浏览器级 TLS/HTTP 指纹、Defuddle 正文抽取、批量抓取、附件/大文件下载、站点特化清洗等能力。

本扩展的 `web_fetch` 仍以搜索工作流中的“按需 URL 预览”为边界，保持无额外依赖和低上下文占用：

- 默认链路：`Tavily Extract` → `Firecrawl Scrape` → `direct fetch`；direct fetch 只使用常见浏览器请求头，不承诺真实 TLS 指纹或 JS 渲染
- 支持格式：`markdown`（默认）、`text`、`html`、`json`、`raw`；其中 `raw` 仍是受输出预算保护的原始正文/`rawHtml` 预览，不是完整响应转储
- 返回 `details.metadata`：URL、最终 URL、状态码、Content-Type、Content-Length、Content-Disposition、标题、描述、canonical、语言等可用字段
- direct fetch 会识别短延迟 `<meta http-equiv="refresh">`，并在正文过薄时尝试合格的 `<link rel="alternate" type="...">`
- 可识别的大文件或二进制目标只返回元信息提示，不把正文注入上下文；不处理登录会话、验证码、JS 执行、批量下载

示例参数：

```json
{
  "url": "https://example.com/docs",
  "format": "markdown",
  "max_output_bytes": 12000
}
```

### 搜索模式预设

`/search-config` 可切换全局默认搜索模式，保存到 `~/.config/pi-search/config.json`。`search` 也支持通过 `profile` 参数临时覆盖。

| 模式 | `profile` | 适合场景 |
| ---- | --------- | -------- |
| 自动 | `auto` | 默认策略，按问题自动判断 |
| 编程文档 | `coding_docs` | 官方文档、API、版本、最小示例 |
| 代码示例 | `code_examples` | GitHub 参考代码、真实项目用法 |
| 项目调研 | `project_research` | README、issue、release、changelog、项目比较 |
| 论文资料 | `academic` | 论文、报告、DOI、作者年份、证据链 |
| 事实核查 | `fact_check` | 多来源验证、冲突证据、可信度判断 |

主模型只注入当前模式的轻量提示；完整模式提示词只在调用 Search API 时注入，降低常驻上下文占用。

### 搜索结果控制

为避免一次搜索把上下文撑爆，默认启用保守预算：

- `search` 默认 `mode=compact`，只返回紧凑答案和 Top 信源；明确需要深度研究时再用 `mode=deep`
- `extra_sources` 是 Tavily/Firecrawl 共享的补充信源总预算，不会再被两个引擎叠加放大
- `search_sources` 支持 `limit` / `offset` 分页，默认每次 20 条
- `web_fetch` 默认 `format=markdown`，最多返回约 12KB 预览；即使未配置 Tavily/Firecrawl 也会尝试 direct fetch，可用 `format` / `max_output_bytes` 临时调整
- `web_map` 默认 `max_breadth=10`、`limit=30`，并走统一输出截断

常用参数：

```json
{
  "profile": "auto | coding_docs | code_examples | project_research | academic | fact_check",
  "mode": "compact | normal | deep | sources_only",
  "max_answer_chars": 6000,
  "max_sources": 8,
  "max_output_bytes": 12000
}
```

## 信源质量准则

本扩展只在 pi 主提示中保留轻量搜索规则，详细准则按搜索模式注入搜索模型请求：

- 编程场景优先官方文档、版本化 API、GitHub 源码和示例
- 论文资料模式优先论文、学术数据库、官方报告和可引用元数据
- 事实核查模式强调独立来源、时效性、冲突证据和置信度
- 默认避免把长网页直接注入上下文，优先使用紧凑结果、信源列表和按需抓取

## 相关链接

- [linux do](https://linux.do)
- [本项目 GitHub](https://github.com/justhil/pi-search)
- [pi 官方文档](https://github.com/earendil-works/pi-mono)
- [pi Extension 文档](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [OpenAI-compatible Chat Completions API](https://platform.openai.com/docs/api-reference/chat)
- [Tavily API](https://docs.tavily.com/)
- [Firecrawl API](https://docs.firecrawl.dev/)

## License

[MIT](LICENSE)
