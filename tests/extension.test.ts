import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const smartFetchMock = vi.hoisted(() => vi.fn());
const defuddleMock = vi.hoisted(() => vi.fn());

vi.mock("wreq-js", () => ({
	fetch: smartFetchMock,
	getProfiles: vi.fn(() => ["chrome_145"]),
}));

vi.mock("defuddle/node", () => ({
	Defuddle: defuddleMock,
}));

import extension from "../index.ts";

type ToolResult = {
	content: Array<{ type: string; text: string }>;
	details?: Record<string, unknown>;
};

type RegisteredTool = {
	name: string;
	parameters?: unknown;
	renderResult?: (...args: any[]) => { render: (width: number) => string[] };
	execute: (...args: unknown[]) => unknown;
};

type RegisteredCommand = {
	description?: string;
	handler: (...args: unknown[]) => unknown;
};

type MessageRenderer = (...args: unknown[]) => unknown;

type EventHandler = (...args: unknown[]) => unknown;

type ToolContext = {
	ui: {
		setStatus: (key: string, text: string | undefined) => void;
		notify: (text: string, kind?: string) => void;
		select: (title: string, items: string[]) => Promise<string | undefined>;
		input: (label: string, value?: string) => Promise<string | undefined>;
	};
};

class FakePi {
	tools = new Map<string, RegisteredTool>();
	commands = new Map<string, RegisteredCommand>();
	events = new Map<string, EventHandler[]>();
	renderers = new Map<string, MessageRenderer>();
	activeTools = new Set<string>(["read", "bash"]);

	on(name: string, handler: EventHandler) {
		const handlers = this.events.get(name) || [];
		handlers.push(handler);
		this.events.set(name, handlers);
	}

	registerTool(tool: RegisteredTool) {
		this.tools.set(tool.name, tool);
		this.activeTools.add(tool.name);
	}

	getActiveTools() {
		return [...this.activeTools];
	}

	setActiveTools(toolNames: string[]) {
		this.activeTools = new Set(toolNames);
	}

	registerCommand(name: string, command: RegisteredCommand) {
		this.commands.set(name, command);
	}

	registerMessageRenderer(type: string, renderer: MessageRenderer) {
		this.renderers.set(type, renderer);
	}

	sendMessage() {
		return undefined;
	}
}

const ENV_KEYS = [
	"SEARCH_API_URL",
	"SEARCH_API_KEY",
	"SEARCH_MODEL",
	"SEARCH_PROFILE",
	"SEARCH_FALLBACK_MODE",
	"SEARCH_MINIMUM_PROFILE",
	"TAVILY_API_KEY",
	"TAVILY_API_URL",
	"FIRECRAWL_API_KEY",
	"FIRECRAWL_API_URL",
	"CONTEXT7_API_KEY",
	"CONTEXT7_BASE_URL",
	"EXA_API_KEY",
	"EXA_BASE_URL",
	"SEARCH_DEBUG",
	"PI_SEARCH_CONFIG_PATH",
	"PI_SEARCH_CONTEXT7_CACHE_DIR",
	"CONTEXT7_RESOLVE_TTL_HOURS",
	"CONTEXT7_DOCS_TTL_HOURS",
	"PI_SEARCH_ENABLE_LEGACY_PLANNING_TOOLS",
	"PI_SEARCH_DEFERRED_TOOLS",
];

const originalFetch = globalThis.fetch;

function installExtension() {
	const pi = new FakePi();
	extension(pi as unknown as ExtensionAPI);
	return pi;
}

function testContext(): ToolContext {
	return {
		ui: {
			setStatus: vi.fn(),
			notify: vi.fn(),
			select: vi.fn(async () => undefined),
			input: vi.fn(async () => undefined),
		},
	};
}

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function textResponse(value: string): Response {
	return new Response(value, {
		status: 200,
		headers: { "content-type": "text/plain" },
	});
}

function htmlResponse(value: string, url = "https://example.com/article"): Response {
	const response = new Response(value, {
		status: 200,
		headers: { "content-type": "text/html; charset=utf-8" },
	});
	Object.defineProperty(response, "url", { value: url });
	return response;
}

async function runTool(
	pi: FakePi,
	name: string,
	params: Record<string, unknown>,
	ctx: ToolContext = testContext(),
): Promise<ToolResult> {
	const tool = pi.tools.get(name);
	expect(tool, `tool ${name} should be registered`).toBeDefined();
	return await tool!.execute("test-call", params, undefined, undefined, ctx) as ToolResult;
}

beforeEach(() => {
	smartFetchMock.mockReset();
	defuddleMock.mockReset();
	for (const key of ENV_KEYS) delete process.env[key];
	process.env.SEARCH_API_URL = "https://search.test/v1";
	process.env.SEARCH_API_KEY = "sk-test";
	process.env.SEARCH_MODEL = "search-model";
	process.env.CONTEXT7_BASE_URL = "https://context7.test";
	process.env.EXA_BASE_URL = "https://exa.test";
	process.env.SEARCH_FALLBACK_MODE = "auto";
	process.env.SEARCH_MINIMUM_PROFILE = "standard";
	const testId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	process.env.PI_SEARCH_CONFIG_PATH = `.pi/tmp/test-config-${testId}/config.json`;
	process.env.PI_SEARCH_CONTEXT7_CACHE_DIR = `.pi/tmp/test-config-${testId}/context7-cache`;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) delete process.env[key];
});

describe("pi-search extension", () => {
	it("registers the enhanced search tools without legacy planning tools by default", () => {
		const pi = installExtension();

		expect([...pi.tools.keys()]).toEqual(expect.arrayContaining([
			"search_tools",
			"search",
			"context7_resolve_library_id",
			"context7_query_docs",
			"context7_get_library_docs",
			"context7_get_cached_doc_raw",
			"docs_search",
			"search_sources",
			"web_fetch",
			"web_map",
			"search_config",
			"search_planning",
		]));
		expect(pi.tools.has("plan_tool_mapping")).toBe(false);
		expect([...pi.tools.values()].every((tool) => typeof tool.renderResult === "function")).toBe(true);
	});

	it("supports Ctrl+O expansion for Pi Search tool output", () => {
		initTheme();
		const pi = installExtension();
		const renderer = pi.tools.get("search_planning")?.renderResult;
		expect(renderer).toBeDefined();

		const result = {
			content: [{
				type: "text",
				text: Array.from({ length: 20 }, (_, index) => `line-${index}`).join("\n"),
			}],
			details: {},
		};
		const theme = { fg: (_color: string, text: string) => text };
		const collapsed = renderer!(result, { expanded: false, isPartial: false }, theme, {}).render(120).join("\n");
		const expanded = renderer!(result, { expanded: true, isPartial: false }, theme, {}).render(120).join("\n");

		expect(collapsed).toContain("line-0");
		expect(collapsed).not.toContain("line-19");
		expect(expanded).toContain("line-19");
	});

	it("keeps only core search tools active until capabilities are requested", async () => {
		const pi = installExtension();
		for (const handler of pi.events.get("session_start") || []) {
			await handler({}, testContext());
		}

		expect(pi.getActiveTools()).toEqual(expect.arrayContaining([
			"read",
			"bash",
			"search_tools",
			"search",
			"docs_search",
			"web_fetch",
		]));
		expect(pi.getActiveTools()).not.toEqual(expect.arrayContaining([
			"context7_query_docs",
			"search_sources",
			"web_map",
			"search_config",
			"search_planning",
		]));

		const result = await runTool(pi, "search_tools", {
			capabilities: ["context7", "planning"],
		});
		expect(result.details?.added_tools).toEqual(expect.arrayContaining([
			"context7_resolve_library_id",
			"context7_query_docs",
			"context7_get_library_docs",
			"context7_get_cached_doc_raw",
			"search_planning",
		]));
		expect(pi.getActiveTools()).toEqual(expect.arrayContaining([
			"context7_query_docs",
			"search_planning",
		]));
	});

	it("can restore legacy multi-call planning tools explicitly", () => {
		process.env.PI_SEARCH_ENABLE_LEGACY_PLANNING_TOOLS = "1";
		const pi = installExtension();

		expect(pi.tools.has("plan_intent")).toBe(true);
		expect(pi.tools.has("plan_tool_mapping")).toBe(true);
	});

	it("resolves Context7 library IDs like the official MCP flow", async () => {
		const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
			const url = String(input);
			if (url.startsWith("https://context7.test/api/v2/search")) {
				return jsonResponse({
					results: [
						{ id: "/react/react", title: "React", description: "React official docs", trustScore: 9, benchmarkScore: 95, totalSnippets: 1200 },
					],
				});
			}
			throw new Error(`Unhandled fetch: ${url}`);
		}) as typeof fetch;
		globalThis.fetch = fetchMock;

		const result = await runTool(installExtension(), "context7_resolve_library_id", {
			libraryName: "React",
			query: "useEffect cleanup",
		});

		expect(result.content[0]?.text).toContain("Selected Library ID");
		expect(result.content[0]?.text).toContain("/react/react");
		expect(result.details?.selected_library_id).toBe("/react/react");
		expect(result.details?.provider_attempts).toEqual([
			expect.objectContaining({ capability: "docs_search", provider: "context7", ok: true }),
		]);
	});

	it("prefers official Context7 docs over query-biased hook collections", async () => {
		let requestedUrl = "";
		const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
			const url = String(input);
			requestedUrl = url;
			if (url.startsWith("https://context7.test/api/v2/search")) {
				return jsonResponse({
					results: [
						{ id: "/uidotdev/usehooks", title: "React Native Hooks", description: "Hooks collection", trustScore: 9, benchmarkScore: 90, totalSnippets: 500 },
						{ id: "/facebook/react", title: "React", description: "The library for web and native user interfaces.", trustScore: 9.2, benchmarkScore: 72.9, totalSnippets: 3414 },
						{ id: "/reactjs/react.dev", title: "React", description: "React.dev is the official documentation website for React.", trustScore: 10, benchmarkScore: 89.9, totalSnippets: 7143 },
					],
				});
			}
			throw new Error(`Unhandled fetch: ${url}`);
		}) as typeof fetch;
		globalThis.fetch = fetchMock;

		const result = await runTool(installExtension(), "context7_resolve_library_id", {
			libraryName: "React",
			query: "hooks cleanup",
		});

		expect(result.details?.selected_library_id).toBe("/reactjs/react.dev");
		expect(requestedUrl).toContain("query=React");
	});

	it("queries Context7 docs directly with a library ID", async () => {
		const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
			const url = String(input);
			if (url.startsWith("https://context7.test/api/v2/context")) {
				return jsonResponse({
					codeSnippets: [{ title: "useEffect cleanup", content: "return () => unsubscribe();" }],
					infoSnippets: [{ title: "Cleanup", content: "Cleanup runs before unmount and before the next effect." }],
				});
			}
			throw new Error(`Unhandled fetch: ${url}`);
		}) as typeof fetch;
		globalThis.fetch = fetchMock;

		const result = await runTool(installExtension(), "context7_query_docs", {
			libraryId: "/react/react",
			query: "useEffect cleanup",
		});

		expect(result.content[0]?.text).toContain("useEffect cleanup");
		expect(result.content[0]?.text).toContain("return () => unsubscribe();");
		expect(result.details?.library_id).toBe("/react/react");
		expect(result.details?.snippets_count).toBe(2);
		expect(result.details?.provider_attempts).toEqual([
			expect.objectContaining({ capability: "docs_search", provider: "context7_docs", ok: true }),
		]);
	});

	it("renders non-json Context7 docs bodies without consuming the response twice", async () => {
		const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
			const url = String(input);
			if (url.startsWith("https://context7.test/api/v2/context")) {
				return textResponse("Plain Context7 documentation body");
			}
			throw new Error(`Unhandled fetch: ${url}`);
		}) as typeof fetch;
		globalThis.fetch = fetchMock;

		const result = await runTool(installExtension(), "context7_query_docs", {
			libraryId: "/plain/docs",
			query: "plain response",
		});

		expect(result.content[0]?.text).toContain("Plain Context7 documentation body");
		expect(result.content[0]?.text).not.toContain("Body is unusable");
		expect(result.details?.snippets_count).toBe(1);
		expect(result.details?.provider_attempts).toEqual([
			expect.objectContaining({ capability: "docs_search", provider: "context7_docs", ok: true }),
		]);
	});

	it("caches Context7 docs and reuses the cached doc_ref", async () => {
		const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
			const url = String(input);
			if (url.startsWith("https://context7.test/api/v2/context")) {
				return jsonResponse({
					codeSnippets: [{ title: "useEffect cleanup", content: "cached cleanup snippet" }],
					infoSnippets: [],
				});
			}
			throw new Error(`Unhandled fetch: ${url}`);
		}) as typeof fetch;
		globalThis.fetch = fetchMock;
		const pi = installExtension();

		const first = await runTool(pi, "context7_query_docs", {
			libraryId: "/react/react",
			query: "useEffect cleanup",
		});
		const second = await runTool(pi, "context7_query_docs", {
			libraryId: "/react/react",
			query: "useEffect cleanup",
		});

		expect(first.details?.cache).toBe("miss");
		expect(second.details?.cache).toBe("hit");
		expect(second.details?.doc_ref).toBe(first.details?.doc_ref);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(second.details?.provider_attempts).toEqual([
			expect.objectContaining({ capability: "docs_search", provider: "context7_cache", ok: true }),
		]);
	});

	it("auto-resolves Context7 library docs and exposes raw cached documents", async () => {
		const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
			const url = String(input);
			if (url.startsWith("https://context7.test/api/v2/search")) {
				return jsonResponse({
					results: [
						{ id: "/react/react", title: "React", description: "React docs", trustScore: 9, versions: ["19.0.0"] },
					],
				});
			}
			if (url.startsWith("https://context7.test/api/v2/context")) {
				return jsonResponse({
					codeSnippets: [{ title: "useEffect cleanup", content: "auto resolved cleanup snippet" }],
					infoSnippets: [{ title: "Effect lifecycle", content: "Effects can return cleanup functions." }],
				});
			}
			throw new Error(`Unhandled fetch: ${url}`);
		}) as typeof fetch;
		globalThis.fetch = fetchMock;
		const pi = installExtension();

		const docs = await runTool(pi, "context7_get_library_docs", {
			libraryName: "React",
			query: "useEffect cleanup",
		});
		const docRef = String(docs.details?.doc_ref);
		const raw = await runTool(pi, "context7_get_cached_doc_raw", { docRef });
		const semantic = await runTool(pi, "context7_get_cached_doc_raw", {
			query: "cleanup lifecycle",
			libraryId: "/react/react",
		});

		expect(docs.content[0]?.text).toContain("auto resolved cleanup snippet");
		expect(docs.content[0]?.text).toContain("Raw cached document available via docRef");
		expect(docs.details?.library_id).toBe("/react/react");
		expect(docs.details?.resolve_cache).toBe("miss");
		expect(docs.details?.docs_cache).toBe("miss");
		expect(docs.details?.provider_attempts).toEqual(expect.arrayContaining([
			expect.objectContaining({ capability: "docs_search", provider: "context7", ok: true }),
			expect.objectContaining({ capability: "docs_search", provider: "context7_docs", ok: true }),
		]));
		expect(raw.content[0]?.text).toContain('"docRef"');
		expect(raw.content[0]?.text).toContain("auto resolved cleanup snippet");
		expect(raw.details?.cache).toBe("hit");
		expect(raw.details?.doc_ref).toBe(docRef);
		expect(semantic.details?.doc_ref).toBe(docRef);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("returns Context7 and Exa docs_search results with provider diagnostics", async () => {
		process.env.EXA_API_KEY = "exa-test";
		const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
			const url = String(input);
			if (url.startsWith("https://context7.test/api/v2/search")) {
				return jsonResponse({
					results: [
						{ id: "/react/react", title: "React", description: "React docs", trustScore: 9, stars: 220000 },
					],
				});
			}
			if (url.startsWith("https://context7.test/api/v2/context")) {
				return jsonResponse({
					codeSnippets: [{ title: "useEffect", content: "useEffect runs after render." }],
					infoSnippets: [],
				});
			}
			if (url === "https://exa.test/search") {
				return jsonResponse({
					results: [
						{ id: "1", title: "React API Reference", url: "https://react.dev/reference/react", highlights: ["Official React reference"] },
					],
				});
			}
			throw new Error(`Unhandled fetch: ${url}`);
		}) as typeof fetch;
		globalThis.fetch = fetchMock;

		const result = await runTool(installExtension(), "docs_search", {
			query: "React useEffect API",
			provider: "all",
			max_results: 3,
		});

		expect(result.content[0]?.text).toContain("Context7 libraries");
		expect(result.content[0]?.text).toContain("Exa results");
		expect(result.details?.sources_count).toBe(2);
		expect(result.details?.fallback_used).toBe(false);
		expect(result.details?.provider_attempts).toEqual(expect.arrayContaining([
			expect.objectContaining({ capability: "docs_search", provider: "context7", ok: true }),
			expect.objectContaining({ capability: "docs_search", provider: "context7_docs", ok: true }),
			expect.objectContaining({ capability: "docs_search", provider: "exa", ok: true }),
		]));
	});

	it("records web_fetch same-capability fallback attempts", async () => {
		process.env.TAVILY_API_KEY = "tvly-test";
		process.env.FIRECRAWL_API_KEY = "fc-test";
		const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
			const url = String(input);
			if (url === "https://api.tavily.com/extract") {
				return jsonResponse({ results: [{ url: "https://example.com/", raw_content: "" }] });
			}
			if (url === "https://api.firecrawl.dev/v2/scrape") {
				return jsonResponse({
					data: {
						markdown: "# Example\n\nFirecrawl fallback content.",
						metadata: { sourceURL: "https://example.com/", title: "Example" },
					},
				});
			}
			throw new Error(`Unhandled fetch: ${url}`);
		}) as typeof fetch;
		globalThis.fetch = fetchMock;

		const result = await runTool(installExtension(), "web_fetch", {
			url: "https://example.com",
			format: "markdown",
		});

		expect(result.content[0]?.text).toContain("Firecrawl fallback content");
		expect(result.details?.provider).toBe("firecrawl");
		expect(result.details?.fallback_used).toBe(true);
		expect(result.details?.provider_attempts).toEqual([
			expect.objectContaining({ capability: "web_fetch", provider: "tavily", ok: false, error: "no_content" }),
			expect.objectContaining({ capability: "web_fetch", provider: "firecrawl", ok: true }),
		]);
	});

	it("uses smart_direct extraction with browser fingerprint options", async () => {
		smartFetchMock.mockResolvedValue(htmlResponse("<html><body><article>Original HTML</article></body></html>"));
		defuddleMock.mockResolvedValue({
			content: "# Extracted Article\n\nReadable content from Defuddle.",
			title: "Extracted Article",
			author: "Ada",
			published: "2026-01-01",
			site: "Example",
			language: "en",
			wordCount: 42,
		});

		const result = await runTool(installExtension(), "web_fetch", {
			url: "https://example.com/article",
			format: "markdown",
			provider: "smart_direct",
			browser: "chrome_145",
			os: "windows",
			maxChars: 5000,
			verbose: true,
		});

		expect(result.content[0]?.text).toContain("Readable content from Defuddle");
		expect(result.content[0]?.text).toContain("> Browser: chrome_145/windows");
		expect(result.details?.provider).toBe("smart_direct");
		expect(result.details?.metadata).toEqual(expect.objectContaining({
			title: "Extracted Article",
			wordCount: 42,
			browser: "chrome_145",
			os: "windows",
		}));
		expect(result.details?.provider_attempts).toEqual([
			expect.objectContaining({ capability: "web_fetch", provider: "smart_direct", ok: true }),
		]);
		expect(smartFetchMock).toHaveBeenCalledWith("https://example.com/article", expect.objectContaining({
			browser: "chrome_145",
			os: "windows",
			redirect: "follow",
			timeout: 15000,
		}));
	});

	it("auto-folds long web_fetch output and saves the full content", async () => {
		const longText = Array.from({ length: 220 }, (_, index) => `line-${index.toString().padStart(3, "0")} ${"x".repeat(20)}`).join("\n");
		const fetchMock = vi.fn(async () => textResponse(longText)) as typeof fetch;
		globalThis.fetch = fetchMock;

		const result = await runTool(installExtension(), "web_fetch", {
			url: "https://example.com/long.txt",
			format: "text",
			provider: "direct",
			max_output_bytes: 12000,
		});

		expect(result.content[0]?.text).toContain("[Output folded:");
		expect(result.details?.provider).toBe("direct");
		expect(result.details?.folded).toBe(true);
		expect(result.details?.truncated).toBe(false);
		expect(typeof result.details?.fullOutputPath).toBe("string");
		expect(Number(result.details?.outputLines)).toBeLessThan(Number(result.details?.totalLines));
	});

	it("enriches search results with docs_search sources and caches them", async () => {
		const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
			const url = String(input);
			if (url === "https://search.test/v1/chat/completions") {
				return textResponse('data: {"choices":[{"delta":{"content":"React useEffect cleanup answer."}}]}\n\ndata: [DONE]\n');
			}
			if (url.startsWith("https://context7.test/api/v2/search")) {
				return jsonResponse({
					results: [
						{ id: "/react/react", title: "React", description: "React official docs" },
					],
				});
			}
			throw new Error(`Unhandled fetch: ${url}`);
		}) as typeof fetch;
		globalThis.fetch = fetchMock;

		const pi = installExtension();
		const result = await runTool(pi, "search", {
			query: "React useEffect cleanup API docs",
			profile: "coding_docs",
			max_sources: 5,
		});

		expect(result.content[0]?.text).toContain("React useEffect cleanup answer");
		expect(result.content[0]?.text).toContain("React");
		expect(result.details?.docs_search_enriched).toBe(true);
		expect(result.details?.evidence_level).toBe("discovery");
		expect(result.details?.source_warning).toContain("web_fetch");
		expect(result.details?.providers_used).toEqual(expect.arrayContaining(["openai_compatible", "context7"]));
		expect(pi.getActiveTools()).toContain("search_sources");
		expect(result.details?.provider_attempts).toEqual(expect.arrayContaining([
			expect.objectContaining({ capability: "main_search", provider: "openai_compatible", ok: true }),
			expect.objectContaining({ capability: "docs_search", provider: "context7", ok: true }),
		]));

		const sources = await runTool(pi, "search_sources", {
			session_id: String(result.details?.session_id),
			format: "full",
		});
		expect(sources.content[0]?.text).toContain("React official docs");
	});

	it("records web_map provider diagnostics", async () => {
		process.env.TAVILY_API_KEY = "tvly-test";
		const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
			const url = String(input);
			if (url === "https://api.tavily.com/map") {
				return jsonResponse({
					base_url: "https://example.com",
					results: ["https://example.com/docs"],
					response_time: 0.12,
				});
			}
			throw new Error(`Unhandled fetch: ${url}`);
		}) as typeof fetch;
		globalThis.fetch = fetchMock;

		const result = await runTool(installExtension(), "web_map", {
			url: "https://example.com",
		});

		expect(result.content[0]?.text).toContain("https://example.com/docs");
		expect(result.details?.fallback_used).toBe(false);
		expect(result.details?.provider_attempts).toEqual([
			expect.objectContaining({ capability: "site_map", provider: "tavily", ok: true }),
		]);
	});

	it("marks web_map errors as failed provider attempts", async () => {
		const result = await runTool(installExtension(), "web_map", {
			url: "https://example.com",
		});

		expect(result.content[0]?.text).toContain("映射失败");
		expect(result.details?.provider_attempts).toEqual([
			expect.objectContaining({ capability: "site_map", provider: "tavily", ok: false }),
		]);
	});

	it("shows capability diagnostics in search_config", async () => {
		process.env.EXA_API_KEY = "exa-test";
		const result = await runTool(installExtension(), "search_config", { action: "show" });

		expect(result.content[0]?.text).toContain("Capability Status");
		expect(result.content[0]?.text).toContain("docs_search");
		expect(result.content[0]?.text).toContain("Fallback Mode");
		expect(result.details?.fallbackMode).toBe("auto");
		expect(result.details?.minimumProfile).toBe("standard");
		expect(result.details).not.toHaveProperty("searchApiKey");
		expect(result.details).not.toHaveProperty("context7ApiKey");
		expect(result.details).not.toHaveProperty("exaApiKey");
	});

	it("builds a one-shot offline research_plan with smart-search evidence boundaries", async () => {
		const pi = installExtension();
		const result = await runTool(pi, "search_planning", {
			question: "How does React useEffect cleanup work?",
			budget: "deep",
			recency_requirement: "recent",
			source_authority_need: "high",
			claim_risk: "medium",
			cross_validation_need: "high",
			sub_queries: [{
				id: "sq1",
				question: "Find official React useEffect cleanup docs",
				reason: "Official API semantics are required",
				tool: "docs_search",
			}],
		});

		expect(result.details?.plan_complete).toBe(true);
		expect(result.details?.research_plan).toEqual(expect.objectContaining({
			mode: "deep_research",
			query_mode: "deep",
			trigger_source: "explicit_tool",
			evidence_policy: "fetch_before_claim",
			preflight: expect.objectContaining({ tool: "search_config" }),
			gap_check: expect.objectContaining({ required: true }),
		}));
		expect(result.content[0]?.text).toContain("docs_search");
		expect(result.content[0]?.text).toContain("Offline plan only");
	});
});
