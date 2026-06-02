import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
	events = new Map<string, EventHandler>();
	renderers = new Map<string, MessageRenderer>();

	on(name: string, handler: EventHandler) {
		this.events.set(name, handler);
	}

	registerTool(tool: RegisteredTool) {
		this.tools.set(tool.name, tool);
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
	process.env.PI_SEARCH_CONFIG_PATH = `.pi/tmp/test-config-${process.pid}-${Date.now()}-${Math.random()}.json`;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) delete process.env[key];
});

describe("pi-search extension", () => {
	it("registers the enhanced search tools", () => {
		const pi = installExtension();

		expect([...pi.tools.keys()]).toEqual(expect.arrayContaining([
			"search",
			"docs_search",
			"search_sources",
			"web_fetch",
			"web_map",
			"search_config",
			"search_planning",
			"plan_tool_mapping",
		]));
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
	});

	it("builds an offline research_plan with docs_search capability", async () => {
		const pi = installExtension();
		const intent = await runTool(pi, "plan_intent", {
			core_question: "How does React useEffect cleanup work?",
			query_type: "factual",
			time_sensitivity: "irrelevant",
			thought: "Need official API docs.",
		});
		const sessionId = String(intent.details?.session_id);

		await runTool(pi, "plan_complexity", {
			session_id: sessionId,
			level: 2,
			estimated_sub_queries: 1,
			estimated_tool_calls: 2,
			justification: "Needs docs and source fetch.",
			thought: "Moderate docs lookup.",
		});
		await runTool(pi, "plan_sub_query", {
			session_id: sessionId,
			id: "sq1",
			goal: "Find official React useEffect cleanup docs",
			expected_output: "Official API semantics",
			boundary: "No blog-only sources",
			tool_hint: "docs_search",
			thought: "Docs-first subquery.",
		});
		await runTool(pi, "plan_search_term", {
			session_id: sessionId,
			term: "React useEffect cleanup docs",
			purpose: "sq1",
			round: 1,
			thought: "Use official docs query.",
		});
		const final = await runTool(pi, "plan_tool_mapping", {
			session_id: sessionId,
			sub_query_id: "sq1",
			tool: "docs_search",
			reason: "Official API docs are required.",
			thought: "Map to docs search.",
		});

		expect(final.details?.plan_complete).toBe(true);
		expect(final.details?.research_plan).toEqual(expect.objectContaining({
			mode: "deep_research",
			evidence_policy: "fetch_before_claim",
		}));
		expect(final.content[0]?.text).toContain("docs_search");
		expect(final.content[0]?.text).toContain("Offline plan only");
	});
});
