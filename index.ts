/**
 * pi-search Extension (v2)
 *
 * 通过可配置搜索模型 API + Tavily + Firecrawl 为 pi 提供完整的网络访问能力。
 * 参考: OpenAI-compatible search model APIs + Tavily + Firecrawl
 *
 * 双引擎架构:
 *   - Search Model: AI 驱动的智能搜索
 *   - Tavily: 高保真网页抓取与站点映射
 *   - Firecrawl: Tavily 失败时自动托底
 *
 * 功能:
 *   - search: AI 网络搜索（带信源缓存）
 *   - search_sources: 获取搜索信源
 *   - web_fetch: 网页内容抓取（Tavily → Firecrawl → Direct 自动降级）
 *   - web_map: 站点结构映射
 *   - 搜索规划: 6 阶段结构化搜索规划
 *   - 配置诊断: 连接测试 + 模型发现
 *   - CLI 命令: /search, /search-config, /search-model, /pi-ext-docs
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Defuddle } from "defuddle/node";
import type { DefuddleResponse } from "defuddle/node";
import { parseHTML } from "linkedom";
import { fetch as wreqFetch } from "wreq-js";
import type { BrowserProfile, EmulationOS, RequestInit as WreqRequestInit } from "wreq-js";
import { appendFile, readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

// =============================================================================
// Types
// =============================================================================

const SEARCH_PROFILE_VALUES = [
	"auto",
	"coding_docs",
	"code_examples",
	"project_research",
	"academic",
	"fact_check",
] as const;

type SearchProfile = (typeof SEARCH_PROFILE_VALUES)[number];
const DEFAULT_SEARCH_API_URL = "https://api.openai.com/v1";

interface SearchConfigFile {
	apiUrl?: string;
	apiKey?: string;
	model?: string;
	searchProfile?: SearchProfile;
	fallbackMode?: FallbackMode;
	minimumProfile?: MinimumProfile;
	tavilyApiKey?: string;
	tavilyApiUrl?: string;
	firecrawlApiKey?: string;
	firecrawlApiUrl?: string;
	context7ApiKey?: string;
	context7BaseUrl?: string;
	exaApiKey?: string;
	exaBaseUrl?: string;
}

interface RuntimeConfig {
	searchApiUrl: string;
	searchApiKey: string;
	searchModel: string;
	searchProfile: SearchProfile;
	fallbackMode: FallbackMode;
	minimumProfile: MinimumProfile;
	tavilyApiUrl: string;
	tavilyApiKey: string;
	firecrawlApiUrl: string;
	firecrawlApiKey: string;
	context7BaseUrl: string;
	context7ApiKey: string;
	exaBaseUrl: string;
	exaApiKey: string;
}

interface Source {
	url: string;
	title?: string;
	description?: string;
	provider?: string;
}

type SearchMode = "compact" | "normal" | "deep" | "sources_only";
const WEB_FETCH_FORMAT_VALUES = ["markdown", "text", "html", "json", "raw"] as const;
const WEB_FETCH_PROVIDER_VALUES = ["auto", "tavily", "firecrawl", "smart_direct", "direct"] as const;
type WebFetchFormat = (typeof WEB_FETCH_FORMAT_VALUES)[number];
type WebFetchProvider = "tavily" | "firecrawl" | "smart_direct" | "direct";
type WebFetchProviderChoice = (typeof WEB_FETCH_PROVIDER_VALUES)[number];
type SmartFetchIncludeReplies = boolean | "extractors";
type Capability = "main_search" | "docs_search" | "web_search" | "web_fetch" | "site_map";
type FallbackMode = "auto" | "off";
type MinimumProfile = "standard" | "off";

interface ProviderAttempt {
	provider: string;
	capability: Capability;
	ok: boolean;
	latencyMs: number;
	error?: string;
}

interface CapabilityStatus {
	capability: Capability;
	providers: Array<{ provider: string; configured: boolean }>;
	available: boolean;
	required: boolean;
	selected?: string;
}

interface WebFetchMetadata {
	url: string;
	finalUrl?: string;
	status?: number;
	contentType?: string;
	contentLength?: number;
	contentDisposition?: string;
	title?: string;
	description?: string;
	canonicalUrl?: string;
	language?: string;
	favicon?: string;
	author?: string;
	published?: string;
	site?: string;
	wordCount?: number;
	browser?: string;
	os?: string;
}

interface SmartDirectOptions {
	browser: string;
	os: string;
	timeoutMs: number;
	maxChars: number;
	headers: Record<string, string>;
	removeImages: boolean;
	includeReplies: SmartFetchIncludeReplies;
	proxy?: string;
	verbose: boolean;
}

interface WebFetchResult {
	content: string;
	provider: WebFetchProvider;
	format: WebFetchFormat;
	metadata: WebFetchMetadata;
}

interface SearchControls {
	mode: SearchMode;
	maxAnswerChars: number;
	maxSources: number;
	maxOutputBytes: number;
}

interface SearchControlInput {
	mode?: string;
	max_answer_chars?: number;
	max_sources?: number;
	max_output_bytes?: number;
}

interface PlanningSession {
	sessionId: string;
	phases: Record<string, PhaseRecord>;
	complexityLevel: number | null;
}

interface PhaseRecord {
	phase: string;
	thought: string;
	data: unknown;
	confidence: number;
}

// =============================================================================
// Sources Cache
// =============================================================================

class SourcesCache {
	private maxSize: number;
	private cache: Map<string, Source[]>;

	constructor(maxSize = 256) {
		this.maxSize = maxSize;
		this.cache = new Map();
	}

	set(sessionId: string, sources: Source[]): void {
		this.cache.set(sessionId, sources);
		// LRU eviction
		if (this.cache.size > this.maxSize) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey) this.cache.delete(firstKey);
		}
	}

	get(sessionId: string): Source[] | undefined {
		const sources = this.cache.get(sessionId);
		if (sources) {
			// Move to end (most recently used)
			this.cache.delete(sessionId);
			this.cache.set(sessionId, sources);
		}
		return sources;
	}
}

const sourcesCache = new SourcesCache(256);

// =============================================================================
// Planning Engine
// =============================================================================

const PHASE_NAMES = [
	"intent_analysis",
	"complexity_assessment",
	"query_decomposition",
	"search_strategy",
	"tool_selection",
	"execution_order",
];

const REQUIRED_PHASES: Record<number, Set<string>> = {
	1: new Set([
		"intent_analysis",
		"complexity_assessment",
		"query_decomposition",
	]),
	2: new Set([
		"intent_analysis",
		"complexity_assessment",
		"query_decomposition",
		"search_strategy",
		"tool_selection",
	]),
	3: new Set(PHASE_NAMES),
};

class PlanningEngine {
	private sessions: Map<string, PlanningSession>;

	constructor() {
		this.sessions = new Map();
	}

	getSession(sessionId: string): PlanningSession | undefined {
		return this.sessions.get(sessionId);
	}

	processPhase(params: {
		phase: string;
		thought: string;
		sessionId?: string;
		isRevision?: boolean;
		confidence?: number;
		phaseData?: unknown;
	}): Record<string, unknown> {
		const {
			phase,
			thought,
			sessionId,
			isRevision = false,
			confidence = 1.0,
			phaseData,
		} = params;

		if (!PHASE_NAMES.includes(phase)) {
			return {
				error: `Unknown phase: ${phase}. Valid: ${PHASE_NAMES.join(", ")}`,
			};
		}

		let session: PlanningSession;
		if (sessionId && this.sessions.has(sessionId)) {
			session = this.sessions.get(sessionId)!;
		} else {
			const sid = sessionId || this.newSessionId();
			session = { sessionId: sid, phases: {}, complexityLevel: null };
			this.sessions.set(sid, session);
		}

		if (phase === "query_decomposition" || phase === "tool_selection") {
			if (isRevision) {
				session.phases[phase] = {
					phase,
					thought,
					data: Array.isArray(phaseData) ? phaseData : [phaseData],
					confidence,
				};
			} else if (
				session.phases[phase] &&
				Array.isArray(session.phases[phase].data)
			) {
				(session.phases[phase].data as unknown[]).push(phaseData);
				session.phases[phase].thought = thought;
				session.phases[phase].confidence = confidence;
			} else {
				session.phases[phase] = {
					phase,
					thought,
					data: [phaseData],
					confidence,
				};
			}
		} else if (phase === "search_strategy") {
			if (isRevision || !session.phases[phase]) {
				session.phases[phase] = { phase, thought, data: phaseData, confidence };
			} else {
				const existing = session.phases[phase];
				const existingData = existing.data as Record<string, unknown>;
				const newData = phaseData as Record<string, unknown>;
				if (existingData && newData) {
					const existingTerms = (existingData.search_terms as unknown[]) || [];
					const newTerms = (newData.search_terms as unknown[]) || [];
					existingData.search_terms = [...existingTerms, ...newTerms];
					if (newData.approach) existingData.approach = newData.approach;
					if (newData.fallback_plan)
						existingData.fallback_plan = newData.fallback_plan;
					existing.thought = thought;
					existing.confidence = confidence;
				}
			}
		} else {
			session.phases[phase] = { phase, thought, data: phaseData, confidence };
		}

		if (
			phase === "complexity_assessment" &&
			phaseData &&
			typeof phaseData === "object"
		) {
			const level = (phaseData as Record<string, unknown>).level;
			if (level === 1 || level === 2 || level === 3) {
				session.complexityLevel = level;
			}
		}

		const completedPhases = PHASE_NAMES.filter((p) => session.phases[p]);
		const requiredPhases =
			REQUIRED_PHASES[session.complexityLevel || 3] || REQUIRED_PHASES[3];
		const remaining = [...requiredPhases].filter((p) => !session.phases[p]);
		const isComplete =
			session.complexityLevel !== null && remaining.length === 0;

		const result: Record<string, unknown> = {
			session_id: session.sessionId,
			completed_phases: completedPhases,
			complexity_level: session.complexityLevel,
			plan_complete: isComplete,
		};

		if (remaining.length > 0) {
			result.phases_remaining = remaining;
		}

		if (isComplete) {
			const plan: Record<string, unknown> = {};
			for (const [name, record] of Object.entries(session.phases)) {
				plan[name] = record.data;
			}
			result.executable_plan = plan;
			result.research_plan = buildResearchPlan(session);
		}

		return result;
	}

	private newSessionId(): string {
		return Math.random().toString(36).slice(2, 14);
	}
}

function buildResearchPlan(session: PlanningSession): Record<string, unknown> {
	const intent = asRecord(session.phases.intent_analysis?.data);
	const complexity = asRecord(session.phases.complexity_assessment?.data);
	const decomposition = asArray(session.phases.query_decomposition?.data).filter(isRecord);
	const strategy = asRecord(session.phases.search_strategy?.data);
	const toolMappings = asArray(session.phases.tool_selection?.data).filter(isRecord);
	const execution = asRecord(session.phases.execution_order?.data);
	const tools = toolMappings.length > 0
		? toolMappings.map((mapping) => String(mapping.tool || "search"))
		: decomposition.map((item) => String(item.tool_hint || "search"));

	return {
		mode: "deep_research",
		query_mode: "deep",
		session_id: session.sessionId,
		intent_signals: {
			recency: ["realtime", "recent"].includes(String(intent.time_sensitivity || "")),
			docs_api_intent: inferDocsIntent(intent, decomposition),
			known_url: hasKnownUrl(intent, decomposition, strategy),
			claim_risk: inferClaimRisk(intent, complexity),
			source_authority_required: true,
			cross_validation_required: session.complexityLevel === 3 || String(intent.query_type) === "fact_check",
		},
		decomposition,
		capability_plan: [...new Set(tools.map((tool) => capabilityForTool(tool)))].map((capability) => ({
			capability,
			purpose: capabilityPurpose(capability),
		})),
		steps: buildResearchSteps(decomposition, strategy, toolMappings, execution),
		evidence_policy: "fetch_before_claim",
		gap_check: buildGapCheck(decomposition, toolMappings),
		usage_boundary: "Offline plan only: this does not call providers, fetch pages, or verify claims automatically.",
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function inferDocsIntent(intent: Record<string, unknown>, decomposition: Record<string, unknown>[]): boolean {
	const text = [intent.core_question, intent.domain, ...decomposition.map((item) => item.goal)].join(" ").toLowerCase();
	return /\b(api|sdk|docs?|documentation|reference|framework|library|github|readme|changelog|migration)\b/.test(text);
}

function hasKnownUrl(...values: unknown[]): boolean {
	return /https?:\/\//.test(JSON.stringify(values));
}

function inferClaimRisk(intent: Record<string, unknown>, complexity: Record<string, unknown>): "low" | "medium" | "high" {
	if (intent.query_type === "factual" || intent.query_type === "comparative") return "high";
	if (Number(complexity.level || 0) >= 2) return "medium";
	return "low";
}

function capabilityPurpose(capability: Capability): string {
	const purposes: Record<Capability, string> = {
		main_search: "Broad synthesis and current web-backed answering",
		docs_search: "Official docs, SDK/API references, GitHub and authoritative technical sources",
		web_search: "Supplementary web source discovery",
		web_fetch: "Exact URL inspection before citing detailed claims",
		site_map: "Discover relevant pages under a known site",
	};
	return purposes[capability];
}

function buildResearchSteps(
	decomposition: Record<string, unknown>[],
	strategy: Record<string, unknown>,
	toolMappings: Record<string, unknown>[],
	execution: Record<string, unknown>,
): Array<Record<string, unknown>> {
	const terms = asArray(strategy.search_terms).filter(isRecord);
	const mappings = new Map(toolMappings.map((mapping) => [String(mapping.sub_query_id || ""), mapping]));
	const steps = decomposition.map((item) => {
		const id = String(item.id || "");
		const mapping = mappings.get(id);
		const term = terms.find((candidate) => String(candidate.purpose || "") === id);
		const tool = String(mapping?.tool || item.tool_hint || "search");
		return {
			subquestion_id: id,
			tool,
			capability: capabilityForTool(tool),
			purpose: mapping?.reason || item.goal || "Gather evidence",
			query: term?.term || item.goal,
			params: mapping?.params || mapping?.params_raw || {},
		};
	});
	return steps.length > 0 ? steps : [{ tool: "search", capability: "main_search", purpose: "Gather initial evidence" }];
}

function buildGapCheck(
	decomposition: Record<string, unknown>[],
	toolMappings: Record<string, unknown>[],
): string[] {
	const mapped = new Set(toolMappings.map((mapping) => String(mapping.sub_query_id || "")));
	const gaps: string[] = [];
	for (const item of decomposition) {
		const id = String(item.id || "");
		if (id && !mapped.has(id)) gaps.push(`Sub-query ${id} has no explicit tool mapping.`);
	}
	if (toolMappings.length === 0) gaps.push("No tool mappings recorded; default to search and fetch high-value sources before claims.");
	return gaps;
}

const planningEngine = new PlanningEngine();

// =============================================================================
// Configuration Manager
// =============================================================================

class ConfigManager {
	private configPath: string;
	private modelsCache: { key: string; models: string[] } | null = null;

	constructor() {
		this.configPath = join(
			homedir(),
			".config",
			"pi-search",
			"config.json",
		);
	}

	getConfigPath(): string {
		return process.env.PI_SEARCH_CONFIG_PATH || this.configPath;
	}

	async loadFile(): Promise<SearchConfigFile> {
		try {
			const content = await readFile(this.getConfigPath(), "utf-8");
			return JSON.parse(content);
		} catch {
			return {};
		}
	}

	async saveFile(config: SearchConfigFile): Promise<void> {
		const configPath = this.getConfigPath();
		await mkdir(dirname(configPath), { recursive: true });
		await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
		this.modelsCache = null;
	}

	async getFullConfig(): Promise<RuntimeConfig> {
		const file = await this.loadFile();
		const searchApiUrl = process.env.SEARCH_API_URL || file.apiUrl || DEFAULT_SEARCH_API_URL;
		return {
			searchApiUrl,
			searchApiKey: process.env.SEARCH_API_KEY || file.apiKey || "",
			searchModel: normalizeSearchModel(
				process.env.SEARCH_MODEL || file.model || "",
				searchApiUrl,
			),
			searchProfile: normalizeSearchProfile(
				process.env.SEARCH_PROFILE || file.searchProfile,
			),
			fallbackMode: normalizeFallbackMode(
				process.env.SEARCH_FALLBACK_MODE || file.fallbackMode,
			),
			minimumProfile: normalizeMinimumProfile(
				process.env.SEARCH_MINIMUM_PROFILE || file.minimumProfile,
			),
			tavilyApiUrl:
				process.env.TAVILY_API_URL ||
				file.tavilyApiUrl ||
				"https://api.tavily.com",
			tavilyApiKey: process.env.TAVILY_API_KEY || file.tavilyApiKey || "",
			firecrawlApiUrl:
				process.env.FIRECRAWL_API_URL ||
				file.firecrawlApiUrl ||
				"https://api.firecrawl.dev/v2",
			firecrawlApiKey:
				process.env.FIRECRAWL_API_KEY || file.firecrawlApiKey || "",
			context7BaseUrl:
				process.env.CONTEXT7_BASE_URL ||
				file.context7BaseUrl ||
				"https://context7.com",
			context7ApiKey: process.env.CONTEXT7_API_KEY || file.context7ApiKey || "",
			exaBaseUrl:
				process.env.EXA_BASE_URL ||
				file.exaBaseUrl ||
				"https://api.exa.ai",
			exaApiKey: process.env.EXA_API_KEY || file.exaApiKey || "",
		};
	}

	async setModel(model: string): Promise<void> {
		const file = await this.loadFile();
		file.model = model;
		await this.saveFile(file);
	}

	async setSearchProfile(profile: SearchProfile): Promise<void> {
		const file = await this.loadFile();
		file.searchProfile = profile;
		await this.saveFile(file);
	}

	async setSearchApi(url: string, key: string): Promise<void> {
		const file = await this.loadFile();
		file.apiUrl = url;
		file.apiKey = key;
		await this.saveFile(file);
	}

	async setTavily(key: string, url?: string): Promise<void> {
		const file = await this.loadFile();
		file.tavilyApiKey = key;
		if (url) file.tavilyApiUrl = url;
		await this.saveFile(file);
	}

	async setFirecrawl(key: string, url?: string): Promise<void> {
		const file = await this.loadFile();
		file.firecrawlApiKey = key;
		if (url) file.firecrawlApiUrl = url;
		await this.saveFile(file);
	}

	async setContext7(key: string, url?: string): Promise<void> {
		const file = await this.loadFile();
		file.context7ApiKey = key;
		if (url) file.context7BaseUrl = url;
		await this.saveFile(file);
	}

	async setExa(key: string, url?: string): Promise<void> {
		const file = await this.loadFile();
		file.exaApiKey = key;
		if (url) file.exaBaseUrl = url;
		await this.saveFile(file);
	}

	async setSearchRuntime(key: "fallbackMode" | "minimumProfile", value: string): Promise<void> {
		const file = await this.loadFile();
		if (key === "fallbackMode") file.fallbackMode = normalizeFallbackMode(value);
		if (key === "minimumProfile") file.minimumProfile = normalizeMinimumProfile(value);
		await this.saveFile(file);
	}

	maskKey(key: string): string {
		if (!key || key.length <= 8) return "***";
		return `${key.slice(0, 4)}${"*".repeat(key.length - 8)}${key.slice(-4)}`;
	}

	getModelsCacheKey(apiUrl: string, apiKey: string): string {
		return `${apiUrl}|${apiKey}`;
	}

	getCachedModels(apiUrl: string, apiKey: string): string[] | null {
		const key = this.getModelsCacheKey(apiUrl, apiKey);
		if (this.modelsCache && this.modelsCache.key === key) {
			return this.modelsCache.models;
		}
		return null;
	}

	setCachedModels(apiUrl: string, apiKey: string, models: string[]): void {
		this.modelsCache = { key: this.getModelsCacheKey(apiUrl, apiKey), models };
	}
}

const configManager = new ConfigManager();

function normalizeSearchModel(model: string, apiUrl: string): string {
	if (!model.trim()) return "";
	if (apiUrl.toLowerCase().includes("openrouter") && !model.includes(":online")) {
		return `${model}:online`;
	}
	return model;
}

const STATUS_KEY = "search";

type StatusContext = {
	ui: { setStatus(key: string, text: string | undefined): void };
};

let nextStatusId = 0;
const activeStatuses: Array<{ id: number; text: string }> = [];

function formatSearchStatus(model: string): string {
	return `Search | ${model}`;
}

function beginStatus(ctx: StatusContext, text: string): () => void {
	const id = ++nextStatusId;
	activeStatuses.push({ id, text });
	ctx.ui.setStatus(STATUS_KEY, text);

	return () => {
		const index = activeStatuses.findIndex((status) => status.id === id);
		if (index >= 0) activeStatuses.splice(index, 1);
		const latest = activeStatuses[activeStatuses.length - 1];
		ctx.ui.setStatus(STATUS_KEY, latest?.text);
	};
}

async function withProviderAttempt<T>(
	attempts: ProviderAttempt[],
	capability: Capability,
	provider: string,
	fn: () => Promise<T>,
): Promise<T> {
	const start = Date.now();
	try {
		const value = await fn();
		attempts.push({ provider, capability, ok: true, latencyMs: Date.now() - start });
		return value;
	} catch (e) {
		attempts.push({
			provider,
			capability,
			ok: false,
			latencyMs: Date.now() - start,
			error: e instanceof Error ? e.message : String(e),
		});
		throw e;
	}
}

async function withOptionalProviderAttempt<T>(
	attempts: ProviderAttempt[],
	capability: Capability,
	provider: string,
	fn: () => Promise<T | null>,
): Promise<T | null> {
	const start = Date.now();
	try {
		const value = await fn();
		attempts.push({
			provider,
			capability,
			ok: value !== null,
			latencyMs: Date.now() - start,
			...(value === null ? { error: "no_content" } : {}),
		});
		return value;
	} catch (e) {
		attempts.push({
			provider,
			capability,
			ok: false,
			latencyMs: Date.now() - start,
			error: e instanceof Error ? e.message : String(e),
		});
		throw e;
	}
}

function hasSuccessfulAttempt(attempts: ProviderAttempt[], capability?: Capability): boolean {
	return attempts.some((attempt) => attempt.ok && (!capability || attempt.capability === capability));
}

function fallbackUsed(attempts: ProviderAttempt[], capability?: Capability): boolean {
	const scoped = capability ? attempts.filter((attempt) => attempt.capability === capability) : attempts;
	return scoped.some((attempt) => !attempt.ok) && scoped.some((attempt) => attempt.ok);
}

function capabilityStatus(config: RuntimeConfig): CapabilityStatus[] {
	const mainConfigured = !!(config.searchApiUrl && config.searchApiKey && config.searchModel);
	const docsProviders = [
		{ provider: "context7", configured: !!config.context7BaseUrl },
		{ provider: "exa", configured: !!config.exaApiKey },
	];
	const webSearchProviders = [
		{ provider: "tavily", configured: !!config.tavilyApiKey },
		{ provider: "firecrawl", configured: !!config.firecrawlApiKey },
	];
	const webFetchProviders = [
		{ provider: "tavily", configured: !!config.tavilyApiKey },
		{ provider: "firecrawl", configured: !!config.firecrawlApiKey },
		{ provider: "smart_direct", configured: true },
		{ provider: "direct", configured: true },
	];
	const statuses: CapabilityStatus[] = [
		{
			capability: "main_search",
			providers: [{ provider: "openai_compatible", configured: mainConfigured }],
			available: mainConfigured,
			required: config.minimumProfile === "standard",
			selected: mainConfigured ? "openai_compatible" : undefined,
		},
		{
			capability: "docs_search",
			providers: docsProviders,
			available: docsProviders.some((provider) => provider.configured),
			required: config.minimumProfile === "standard",
			selected: docsProviders.find((provider) => provider.configured)?.provider,
		},
		{
			capability: "web_search",
			providers: webSearchProviders,
			available: webSearchProviders.some((provider) => provider.configured),
			required: false,
			selected: webSearchProviders.find((provider) => provider.configured)?.provider,
		},
		{
			capability: "web_fetch",
			providers: webFetchProviders,
			available: true,
			required: config.minimumProfile === "standard",
			selected: webFetchProviders.find((provider) => provider.configured)?.provider,
		},
		{
			capability: "site_map",
			providers: [{ provider: "tavily", configured: !!config.tavilyApiKey }],
			available: !!config.tavilyApiKey,
			required: false,
			selected: config.tavilyApiKey ? "tavily" : undefined,
		},
	];
	return statuses;
}

function minimumProfileSatisfied(statuses: CapabilityStatus[], profile: MinimumProfile): boolean {
	if (profile === "off") return true;
	return statuses.every((status) => !status.required || status.available);
}

function providerAttemptsMarkdown(attempts: ProviderAttempt[]): string[] {
	if (attempts.length === 0) return [];
	return [
		"\n### Provider attempts",
		...attempts.map((attempt) => {
			const state = attempt.ok ? "✅" : "❌";
			const error = attempt.error ? ` — ${attempt.error}` : "";
			return `- ${state} ${attempt.capability}/${attempt.provider}: ${attempt.latencyMs}ms${error}`;
		}),
	];
}

function capabilityDiagnostics(
	config: RuntimeConfig,
	attempts: ProviderAttempt[],
	capability?: Capability,
): Record<string, unknown> {
	const statuses = capabilityStatus(config);
	return {
		provider_attempts: attempts,
		fallback_used: fallbackUsed(attempts, capability),
		capability_status: statuses,
		minimum_profile: {
			profile: config.minimumProfile,
			satisfied: minimumProfileSatisfied(statuses, config.minimumProfile),
		},
	};
}

// =============================================================================
// HTTP Utilities
// =============================================================================

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;
const DEFAULT_MAX_OUTPUT_LINES = 800;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const SMART_DIRECT_DEFAULT_BROWSER = "chrome_145";
const SMART_DIRECT_DEFAULT_OS = "windows";
const SMART_DIRECT_DEFAULT_TIMEOUT_MS = 15_000;
const SMART_DIRECT_DEFAULT_MAX_CHARS = 50_000;
const SMART_DIRECT_DEFAULT_INCLUDE_REPLIES: SmartFetchIncludeReplies = "extractors";
const SMART_DIRECT_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const SMART_DIRECT_ACCEPT_LANGUAGE = "en-US,en;q=0.9";
const AUTO_FOLD_BYTES = 8 * 1024;
const AUTO_FOLD_LINES = 180;
const DIRECT_FETCH_MIN_INPUT_BYTES = 256 * 1024;
const DIRECT_FETCH_MAX_INPUT_BYTES = 2 * 1024 * 1024;
const DIRECT_FETCH_LARGE_BODY_BYTES = 5 * 1024 * 1024;
const SEARCH_MODE_VALUES: SearchMode[] = ["compact", "normal", "deep", "sources_only"];
const WEB_FETCH_LIGHT_PROMPT =
	"web_fetch can be used independently when the user gives a concrete HTTP(S) URL, and it also remains the follow-up inspection tool for selected search sources. Prefer markdown previews; use html/raw/json only for source/API/debug needs.";
const SEARCH_MODE_DEFAULTS: Record<SearchMode, Omit<SearchControls, "mode">> = {
	compact: { maxAnswerChars: 6000, maxSources: 8, maxOutputBytes: 12 * 1024 },
	normal: { maxAnswerChars: 12000, maxSources: 12, maxOutputBytes: 20 * 1024 },
	deep: { maxAnswerChars: 24000, maxSources: 20, maxOutputBytes: 32 * 1024 },
	sources_only: { maxAnswerChars: 0, maxSources: 20, maxOutputBytes: 10 * 1024 },
};

type SearchDefaults = Omit<SearchControls, "mode">;

interface SearchProfileDefinition {
	label: string;
	description: string;
	lightPrompt: string;
	searchPrompt: string;
	defaults: Record<SearchMode, SearchDefaults>;
}

const SEARCH_PROFILE_DEFS: Record<SearchProfile, SearchProfileDefinition> = {
	auto: {
		label: "自动",
		description: "根据问题自动选择搜索策略",
		lightPrompt:
			"Current search profile: auto. Let search infer the source strategy, keep results compact, and avoid long page fetches unless needed.",
		searchPrompt: `# Search Profile: Auto

Infer the best search strategy from the query.
If it is about programming, prefer official docs and GitHub.
If it is about academic or research material, prioritize papers, reports, and multi-source evidence.
If it is about factual claims, verify with independent sources.
Keep the result compact unless the query explicitly asks for depth.`,
		defaults: SEARCH_MODE_DEFAULTS,
	},
	coding_docs: {
		label: "编程文档",
		description: "官方文档、API、版本、最小示例",
		lightPrompt:
			"Current search profile: coding_docs. Prefer official docs, versioned API references, and compact source-first results.",
		searchPrompt: `# Search Profile: Coding Docs

Goal:
Find precise technical documentation for programming tasks.

Source priority:
1. Official documentation
2. Versioned API reference
3. Official examples
4. GitHub README, release notes, or changelog
5. High-quality community articles only as fallback

Output:
- Direct answer first
- API names, function signatures, config keys, and version notes when relevant
- Minimal example if useful
- Mention whether the source is official
- Return only the most relevant links

Avoid:
- Long background explanations
- Blog-first answers when official docs exist
- Unverified snippets`,
		defaults: {
			compact: { maxAnswerChars: 3500, maxSources: 6, maxOutputBytes: 9000 },
			normal: { maxAnswerChars: 7000, maxSources: 10, maxOutputBytes: 14 * 1024 },
			deep: { maxAnswerChars: 14000, maxSources: 16, maxOutputBytes: 24 * 1024 },
			sources_only: { maxAnswerChars: 0, maxSources: 10, maxOutputBytes: 9000 },
		},
	},
	code_examples: {
		label: "代码示例",
		description: "GitHub 参考代码、真实项目用法",
		lightPrompt:
			"Current search profile: code_examples. Prefer official examples and real repository file links; avoid large code dumps.",
		searchPrompt: `# Search Profile: Code Examples

Goal:
Find real-world code examples or official sample implementations.

Source priority:
1. Official example repositories
2. Framework or library GitHub repos
3. Well-known open-source projects
4. Gists or blogs only as fallback

Output:
- Repository name
- File path or direct URL when possible
- Short reason why the example is relevant
- Small snippet or usage summary
- License caution if the user may copy code

Avoid:
- Large code dumps
- Toy examples unless official
- Sources without clear file paths`,
		defaults: {
			compact: { maxAnswerChars: 4000, maxSources: 8, maxOutputBytes: 10000 },
			normal: { maxAnswerChars: 8000, maxSources: 12, maxOutputBytes: 16 * 1024 },
			deep: { maxAnswerChars: 16000, maxSources: 20, maxOutputBytes: 26 * 1024 },
			sources_only: { maxAnswerChars: 0, maxSources: 12, maxOutputBytes: 10000 },
		},
	},
	project_research: {
		label: "项目调研",
		description: "项目、工具、框架、README、issue、changelog",
		lightPrompt:
			"Current search profile: project_research. Prefer official sites, README, changelog, release notes, and maintenance signals.",
		searchPrompt: `# Search Profile: Project Research

Goal:
Research a project, library, framework, tool, or ecosystem.

Source priority:
1. Official website or docs
2. GitHub README
3. Release notes or changelog
4. Issues or discussions
5. Reputable comparisons or articles

Output:
- What it is
- Current state and maintenance signal
- Strengths and limitations
- Relevant links
- Mention stale or uncertain information

Avoid:
- Overclaiming popularity or stability without evidence`,
		defaults: {
			compact: { maxAnswerChars: 6000, maxSources: 10, maxOutputBytes: 12 * 1024 },
			normal: { maxAnswerChars: 12000, maxSources: 16, maxOutputBytes: 20 * 1024 },
			deep: { maxAnswerChars: 24000, maxSources: 24, maxOutputBytes: 32 * 1024 },
			sources_only: { maxAnswerChars: 0, maxSources: 16, maxOutputBytes: 12 * 1024 },
		},
	},
	academic: {
		label: "论文资料",
		description: "论文、报告、DOI、作者年份、证据链",
		lightPrompt:
			"Current search profile: academic. Prefer citeable papers, reports, DOI/stable URLs, and multi-source evidence.",
		searchPrompt: `# Search Profile: Academic Research

Goal:
Find accurate, citeable research material.

Source priority:
1. Peer-reviewed papers
2. Academic databases
3. Official reports or white papers
4. Books or institutional publications
5. Reputable secondary sources only as context

Output:
- Author, year, title, and venue if available
- DOI or stable URL if available
- Main claim, method, and evidence
- Limitations
- Conflicting findings if present
- Separate confirmed facts from uncertain claims

Avoid:
- Single-source conclusions
- Blog-style summaries as primary evidence
- Missing citation metadata when available`,
		defaults: {
			compact: { maxAnswerChars: 12000, maxSources: 20, maxOutputBytes: 24 * 1024 },
			normal: { maxAnswerChars: 18000, maxSources: 30, maxOutputBytes: 32 * 1024 },
			deep: { maxAnswerChars: 32000, maxSources: 40, maxOutputBytes: 48 * 1024 },
			sources_only: { maxAnswerChars: 0, maxSources: 30, maxOutputBytes: 18 * 1024 },
		},
	},
	fact_check: {
		label: "事实核查",
		description: "多来源验证、冲突证据、可信度判断",
		lightPrompt:
			"Current search profile: fact_check. Verify claims with independent timely sources and surface conflicts or uncertainty.",
		searchPrompt: `# Search Profile: Fact Check

Goal:
Verify factual claims using independent and timely sources.

Source priority:
1. Primary sources
2. Official announcements or public records
3. Reputable media
4. Independent expert analysis
5. Wikipedia only as background, not primary proof

Output:
- Verdict first: likely true, likely false, mixed, or unresolved
- Evidence for and against
- Source freshness
- Known uncertainty
- Confidence level

Avoid:
- Treating repeated syndicated reports as independent sources
- Hiding conflicting evidence`,
		defaults: {
			compact: { maxAnswerChars: 7000, maxSources: 12, maxOutputBytes: 16 * 1024 },
			normal: { maxAnswerChars: 12000, maxSources: 18, maxOutputBytes: 24 * 1024 },
			deep: { maxAnswerChars: 22000, maxSources: 28, maxOutputBytes: 36 * 1024 },
			sources_only: { maxAnswerChars: 0, maxSources: 18, maxOutputBytes: 14 * 1024 },
		},
	},
};

function parseSearchProfile(value: unknown): SearchProfile | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
	return SEARCH_PROFILE_VALUES.includes(normalized as SearchProfile)
		? (normalized as SearchProfile)
		: null;
}

function normalizeSearchProfile(value: unknown): SearchProfile {
	return parseSearchProfile(value) || "auto";
}

function normalizeFallbackMode(value: unknown): FallbackMode {
	return value === "off" ? "off" : "auto";
}

function normalizeMinimumProfile(value: unknown): MinimumProfile {
	return value === "off" ? "off" : "standard";
}

function formatSearchProfile(profile: SearchProfile): string {
	const definition = SEARCH_PROFILE_DEFS[profile];
	return `${definition.label} (${profile})`;
}

function searchProfileMenuItems(current: SearchProfile): string[] {
	return SEARCH_PROFILE_VALUES.map((profile) => {
		const definition = SEARCH_PROFILE_DEFS[profile];
		const prefix = profile === current ? "✓ " : "  ";
		return `${prefix}${definition.label} - ${definition.description}`;
	});
}

function searchProfileFromMenuItem(item: string): SearchProfile | null {
	const label = item.replace(/^\s*✓?\s*/, "").split(" - ")[0]?.trim();
	for (const profile of SEARCH_PROFILE_VALUES) {
		if (SEARCH_PROFILE_DEFS[profile].label === label) return profile;
	}
	return null;
}

function getDebugConfig(): { enabled: boolean; logDir: string; level: string } {
	const enabled = ["true", "1", "yes", "on"].includes(
		(process.env.SEARCH_DEBUG || "").toLowerCase(),
	);
	const configuredDir = process.env.SEARCH_LOG_DIR || join(homedir(), ".config", "pi-search", "logs");
	return {
		enabled,
		logDir: isAbsolute(configuredDir)
			? configuredDir
			: join(homedir(), ".config", "pi-search", configuredDir),
		level: (process.env.SEARCH_LOG_LEVEL || "info").toLowerCase(),
	};
}

async function debugLog(event: string, details: Record<string, unknown> = {}): Promise<void> {
	const config = getDebugConfig();
	if (!config.enabled) return;
	try {
		await mkdir(config.logDir, { recursive: true });
		const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
		const file = join(config.logDir, `pi-search-${date}.log`);
		const sanitized = sanitizeLogDetails(details);
		await appendFile(
			file,
			`${new Date().toISOString()} ${config.level.toUpperCase()} ${event} ${JSON.stringify(sanitized)}\n`,
			"utf8",
		);
	} catch {
		// Never let debug logging affect tool execution.
	}
}

function sanitizeLogDetails(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => sanitizeLogDetails(item));
	if (!value || typeof value !== "object") return value;
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (/key|token|secret|authorization/i.test(key)) {
			result[key] = typeof entry === "string" ? maskSecret(entry) : "***";
		} else {
			result[key] = sanitizeLogDetails(entry);
		}
	}
	return result;
}

function maskSecret(value: string): string {
	if (!value) return "";
	if (value.length <= 8) return "***";
	return `${value.slice(0, 4)}${"*".repeat(value.length - 8)}${value.slice(-4)}`;
}

function createTimeoutSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal | undefined {
	return abortSignalAny([signal, AbortSignal.timeout(timeoutMs)]);
}

class HttpStatusError extends Error {
	readonly status: number;
	readonly body: string;

	constructor(status: number, body: string) {
		super(`HTTP ${status}: ${body.slice(0, 300)}`);
		this.name = "HttpStatusError";
		this.status = status;
		this.body = body;
	}
}

function getRetryConfig(): { maxRetries: number; maxWaitMs: number; multiplierMs: number } {
	const attempts = Number(process.env.SEARCH_RETRY_MAX_ATTEMPTS || "3");
	const maxWait = Number(process.env.SEARCH_RETRY_MAX_WAIT || "10");
	const multiplier = Number(process.env.SEARCH_RETRY_MULTIPLIER || "1");
	return {
		maxRetries: Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 3,
		maxWaitMs: (Number.isFinite(maxWait) && maxWait > 0 ? maxWait : 10) * 1000,
		multiplierMs: (Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1) * 1000,
	};
}

function parseRetryAfterMs(value: string | null): number | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
		return Math.max(0, Number(trimmed) * 1000);
	}
	const dateMs = Date.parse(trimmed);
	if (Number.isNaN(dateMs)) return null;
	return Math.max(0, dateMs - Date.now());
}

function exponentialBackoffMs(attempt: number, maxWaitMs: number, multiplierMs: number): number {
	const jitter = Math.random() * 1000;
	return Math.min(multiplierMs * 2 ** attempt + jitter, maxWaitMs);
}

function isRetryableError(error: Error): boolean {
	if (error.name === "AbortError") return false;
	if (error instanceof HttpStatusError) return RETRYABLE_STATUS.has(error.status);
	return true;
}

async function fetchWithRetry(
	url: string,
	init: RequestInit,
	maxRetries = getRetryConfig().maxRetries,
): Promise<Response> {
	let lastError: Error | null = null;
	const retryConfig = getRetryConfig();
	const startedAt = Date.now();

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			await debugLog("request.start", { url, attempt: attempt + 1, maxRetries });
			const response = await fetch(url, init);

			if (!response.ok) {
				const text = await response.text().catch(() => "");
				const error = new HttpStatusError(response.status, text);
				const shouldRetry = RETRYABLE_STATUS.has(response.status) && attempt < maxRetries;
				if (shouldRetry) {
					const retryAfterMs =
						response.status === 429
							? parseRetryAfterMs(response.headers.get("Retry-After"))
							: null;
					const waitMs =
						retryAfterMs ??
						exponentialBackoffMs(
							attempt,
							retryConfig.maxWaitMs,
							retryConfig.multiplierMs,
						);
					await debugLog("request.retry", {
						url,
						attempt: attempt + 1,
						status: response.status,
						waitMs,
					});
					await sleep(waitMs);
					continue;
				}
				await debugLog("request.error", { url, status: response.status, body: text.slice(0, 300) });
				throw error;
			}

			await debugLog("request.success", {
				url,
				status: response.status,
				attempt: attempt + 1,
				elapsedMs: Date.now() - startedAt,
			});
			return response;
		} catch (e) {
			lastError = e instanceof Error ? e : new Error(String(e));
			if (!isRetryableError(lastError) || attempt >= maxRetries) {
				await debugLog("request.failed", {
					url,
					attempt: attempt + 1,
					error: lastError.message,
				});
				throw lastError;
			}
			const waitMs = exponentialBackoffMs(
				attempt,
				retryConfig.maxWaitMs,
				retryConfig.multiplierMs,
			);
			await debugLog("request.retry", {
				url,
				attempt: attempt + 1,
				error: lastError.message,
				waitMs,
			});
			await sleep(waitMs);
		}
	}

	throw lastError || new Error("Request failed");
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function abortSignalAny(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
	const active = signals.filter((signal): signal is AbortSignal => !!signal);
	if (active.length === 0) return undefined;
	if (active.length === 1) return active[0];
	if (typeof AbortSignal.any === "function") return AbortSignal.any(active);

	const controller = new AbortController();
	const abort = () => controller.abort();
	for (const signal of active) {
		if (signal.aborted) {
			abort();
			break;
		}
		signal.addEventListener("abort", abort, { once: true });
	}
	return controller.signal;
}

function truncateText(
	text: string,
	options: { maxBytes?: number; maxLines?: number } = {},
): { content: string; truncated: boolean; totalBytes: number; totalLines: number; outputBytes: number; outputLines: number } {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	const maxLines = options.maxLines ?? DEFAULT_MAX_OUTPUT_LINES;
	const lines = text.split(/\r?\n/);
	const totalBytes = Buffer.byteLength(text, "utf8");
	const totalLines = lines.length;
	let outputLines = 0;
	let outputBytes = 0;
	const kept: string[] = [];

	for (const line of lines) {
		if (outputLines >= maxLines || outputBytes >= maxBytes) break;
		const separator = kept.length > 0 ? "\n" : "";
		const availableBytes = maxBytes - outputBytes - Buffer.byteLength(separator, "utf8");
		if (availableBytes <= 0) break;

		const lineBytes = Buffer.byteLength(line, "utf8");
		if (lineBytes > availableBytes) {
			let chunk = "";
			let chunkBytes = 0;
			for (const char of line) {
				const charBytes = Buffer.byteLength(char, "utf8");
				if (chunkBytes + charBytes > availableBytes) break;
				chunk += char;
				chunkBytes += charBytes;
			}
			if (chunk) {
				kept.push(chunk);
				outputLines++;
				outputBytes += Buffer.byteLength(separator + chunk, "utf8");
			}
			break;
		}

		kept.push(line);
		outputLines++;
		outputBytes += Buffer.byteLength(separator + line, "utf8");
	}

	const truncated = outputLines < totalLines || outputBytes < totalBytes;
	return {
		content: kept.join("\n"),
		truncated,
		totalBytes,
		totalLines,
		outputBytes,
		outputLines,
	};
}

async function saveFullOutput(prefix: string, content: string, extension = "md"): Promise<string | null> {
	try {
		const dir = join(tmpdir(), "pi-search");
		await mkdir(dir, { recursive: true });
		const safePrefix = prefix.replace(/[^a-z0-9_-]/gi, "_").slice(0, 40) || "output";
		const safeExtension = extension.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "txt";
		const file = join(dir, `${safePrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${safeExtension}`);
		await writeFile(file, content, "utf8");
		return file;
	} catch {
		return null;
	}
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function extensionForOutputFormat(format: WebFetchFormat): string {
	if (format === "json") return "json";
	if (format === "html") return "html";
	if (format === "text" || format === "raw") return "txt";
	return "md";
}

async function truncateToolOutput(content: string, prefix: string, options: { maxBytes?: number; maxLines?: number; extension?: string; foldBytes?: number; foldLines?: number } = {}): Promise<{
	content: string;
	truncated: boolean;
	folded?: boolean;
	fullOutputPath?: string;
	outputBytes: number;
	totalBytes: number;
	outputLines: number;
	totalLines: number;
}> {
	const maxBytes = options.maxBytes ?? 12 * 1024;
	const maxLines = options.maxLines ?? 400;
	const foldBytes = Math.min(maxBytes, options.foldBytes ?? AUTO_FOLD_BYTES);
	const foldLines = Math.min(maxLines, options.foldLines ?? AUTO_FOLD_LINES);
	const preview = truncateText(content, { maxBytes: foldBytes, maxLines: foldLines });
	if (!preview.truncated) return preview;

	const fullOutputPath = await saveFullOutput(prefix, content, options.extension);
	const hardTruncated = content.length > preview.content.length && (
		preview.totalBytes > maxBytes || preview.totalLines > maxLines
	);
	let notice =
		`\n\n[Output ${hardTruncated ? "truncated" : "folded"}: showing ${preview.outputLines} of ${preview.totalLines} lines ` +
		`(${formatSize(preview.outputBytes)} of ${formatSize(preview.totalBytes)}).`;
	if (fullOutputPath) notice += ` Full output saved to: ${fullOutputPath}`;
	notice += "]";

	return {
		...preview,
		truncated: hardTruncated,
		folded: !hardTruncated,
		content: preview.content + notice,
		fullOutputPath: fullOutputPath || undefined,
	};
}

function newSessionId(): string {
	return Math.random().toString(36).slice(2, 14);
}

function getLocalTimeInfo(): string {
	const now = new Date();
	const weekdays = [
		"星期日",
		"星期一",
		"星期二",
		"星期三",
		"星期四",
		"星期五",
		"星期六",
	];
	const weekday = weekdays[now.getDay()];
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Local";
	const pad = (n: number) => String(n).padStart(2, "0");

	return (
		`[Current Time Context]\n` +
		`- Date: ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} (${weekday})\n` +
		`- Time: ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}\n` +
		`- Timezone: ${tz}\n\n`
	);
}

function needsTimeContext(query: string): boolean {
	const cnKeywords = [
		"当前",
		"现在",
		"今天",
		"明天",
		"昨天",
		"本周",
		"上周",
		"下周",
		"本月",
		"上月",
		"下月",
		"今年",
		"去年",
		"明年",
		"最新",
		"最近",
		"近期",
		"刚刚",
		"刚才",
		"实时",
		"目前",
	];
	const enKeywords = [
		"current",
		"now",
		"today",
		"tomorrow",
		"yesterday",
		"this week",
		"last week",
		"next week",
		"this month",
		"last month",
		"latest",
		"recent",
		"recently",
		"just now",
		"real-time",
		"up-to-date",
	];
	const lower = query.toLowerCase();
	return (
		cnKeywords.some((k) => query.includes(k)) ||
		enKeywords.some((k) => lower.includes(k))
	);
}

// =============================================================================
// Source Extraction Utilities
// =============================================================================

const URL_PATTERN = /https?:\/\/[^\s<>"'`，。、；：！？》）】)]+/g;
const MD_LINK_PATTERN = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
const MD_LINK_LINE_PATTERN = /\[[^\]]+\]\(https?:\/\/[^)]+\)/;
const SOURCES_HEADING_PATTERN =
	/(?:^|\n)(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:sources?|references?|citations?|信源|参考资料|参考|引用|来源列表|来源)\s*(?:\*\*|__)?(?:\s*[（(][^)\n]*[)）])?\s*[:：]?\s*$/gim;
const SOURCES_FUNCTION_PATTERN =
	/(^|\n)\s*(sources|source|citations|citation|references|reference|citation_card|source_cards|source_card)\s*\(/gim;

type UnknownRecord = Record<string, unknown>;

function extractUrls(text: string): string[] {
	const seen = new Set<string>();
	const urls: string[] = [];
	for (const m of text.matchAll(URL_PATTERN)) {
		const url = m[0].replace(/[.,;:!?]+$/, "");
		if (!seen.has(url)) {
			seen.add(url);
			urls.push(url);
		}
	}
	return urls;
}

function extractSourcesFromText(text: string): Source[] {
	const sources: Source[] = [];
	const seen = new Set<string>();

	for (const [, title, url] of text.matchAll(MD_LINK_PATTERN)) {
		const cleanUrl = url.trim();
		if (!cleanUrl || seen.has(cleanUrl)) continue;
		seen.add(cleanUrl);
		sources.push({ url: cleanUrl, title: title.trim() || undefined });
	}

	for (const url of extractUrls(text)) {
		if (!seen.has(url)) {
			seen.add(url);
			sources.push({ url });
		}
	}

	return sources;
}

function splitAnswerAndSources(text: string): {
	answer: string;
	sources: Source[];
} {
	const trimmed = text.trim();
	if (!trimmed) return { answer: "", sources: [] };

	return (
		splitFunctionCallSources(trimmed) ||
		splitHeadingSources(trimmed) ||
		splitDetailsBlockSources(trimmed) ||
		splitTailLinkBlock(trimmed) ||
		{ answer: trimmed, sources: [] }
	);
}

function splitFunctionCallSources(text: string): { answer: string; sources: Source[] } | null {
	const matches = [...text.matchAll(SOURCES_FUNCTION_PATTERN)];
	for (let i = matches.length - 1; i >= 0; i--) {
		const match = matches[i];
		const openParenIndex = (match.index ?? 0) + match[0].length - 1;
		const extracted = extractBalancedCallAtEnd(text, openParenIndex);
		if (!extracted) continue;
		const sources = parseSourcesPayload(extracted.argsText);
		if (sources.length === 0) continue;
		return { answer: text.slice(0, match.index).trimEnd(), sources };
	}
	return null;
}

function extractBalancedCallAtEnd(
	text: string,
	openParenIndex: number,
): { closeParenIndex: number; argsText: string } | null {
	if (text[openParenIndex] !== "(") return null;
	let depth = 1;
	let inString: string | null = null;
	let escape = false;

	for (let index = openParenIndex + 1; index < text.length; index++) {
		const ch = text[index];
		if (inString) {
			if (escape) {
				escape = false;
				continue;
			}
			if (ch === "\\") {
				escape = true;
				continue;
			}
			if (ch === inString) inString = null;
			continue;
		}

		if (ch === '"' || ch === "'") {
			inString = ch;
			continue;
		}
		if (ch === "(") {
			depth++;
			continue;
		}
		if (ch === ")") {
			depth--;
			if (depth === 0) {
				if (text.slice(index + 1).trim()) return null;
				return { closeParenIndex: index, argsText: text.slice(openParenIndex + 1, index) };
			}
		}
	}
	return null;
}

function splitHeadingSources(text: string): { answer: string; sources: Source[] } | null {
	const matches = [...text.matchAll(SOURCES_HEADING_PATTERN)];
	for (let i = matches.length - 1; i >= 0; i--) {
		const match = matches[i];
		const start = match.index ?? 0;
		const sources = extractSourcesFromText(text.slice(start));
		if (sources.length === 0) continue;
		return { answer: text.slice(0, start).trimEnd(), sources };
	}
	return null;
}

function splitDetailsBlockSources(text: string): { answer: string; sources: Source[] } | null {
	const lower = text.toLowerCase();
	const closeIndex = lower.lastIndexOf("</details>");
	if (closeIndex === -1) return null;
	if (text.slice(closeIndex + "</details>".length).trim()) return null;
	const openIndex = lower.lastIndexOf("<details", closeIndex);
	if (openIndex === -1) return null;
	const blockText = text.slice(openIndex, closeIndex + "</details>".length);
	const sources = extractSourcesFromText(blockText);
	if (sources.length < 2) return null;
	return { answer: text.slice(0, openIndex).trimEnd(), sources };
}

function splitTailLinkBlock(text: string): { answer: string; sources: Source[] } | null {
	const lines = text.split(/\r?\n/);
	let index = lines.length - 1;
	while (index >= 0 && !lines[index].trim()) index--;
	if (index < 0) return null;

	const tailEnd = index;
	let linkCount = 0;
	while (index >= 0) {
		const line = lines[index].trim();
		if (!line) {
			index--;
			continue;
		}
		if (!isLinkOnlyLine(line)) break;
		linkCount++;
		index--;
	}

	const tailStart = index + 1;
	if (linkCount < 2) return null;
	const sources = extractSourcesFromText(lines.slice(tailStart, tailEnd + 1).join("\n"));
	if (sources.length === 0) return null;
	return { answer: lines.slice(0, tailStart).join("\n").trimEnd(), sources };
}

function isLinkOnlyLine(line: string): boolean {
	const stripped = line.replace(/^\s*(?:[-*]|\d+\.)\s*/, "").trim();
	return !!stripped && (stripped.startsWith("http://") || stripped.startsWith("https://") || MD_LINK_LINE_PATTERN.test(stripped));
}

function parseSourcesPayload(payload: string): Source[] {
	const trimmed = payload.trim().replace(/;\s*$/, "");
	if (!trimmed) return [];

	const jsonSources = parseJsonLikeSources(trimmed);
	if (jsonSources.length > 0) return jsonSources;
	return extractSourcesFromText(trimmed);
}

function parseJsonLikeSources(payload: string): Source[] {
	for (const candidate of jsonCandidates(payload)) {
		try {
			return normalizeSources(JSON.parse(candidate));
		} catch {
			// try next compatibility transform
		}
	}
	return [];
}

function jsonCandidates(payload: string): string[] {
	const candidates = [payload];
	// Best-effort compatibility for Python literal output: single quotes and booleans.
	const pythonish = payload
		.replace(/\bNone\b/g, "null")
		.replace(/\bTrue\b/g, "true")
		.replace(/\bFalse\b/g, "false")
		.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_m, inner: string) => JSON.stringify(inner.replace(/\\'/g, "'")));
	if (pythonish !== payload) candidates.push(pythonish);
	return candidates;
}

function normalizeSources(data: unknown): Source[] {
	let items: unknown[];
	if (Array.isArray(data)) {
		items = data;
	} else if (isRecord(data)) {
		for (const key of ["sources", "citations", "references", "urls"]) {
			if (key in data) return normalizeSources(data[key]);
		}
		items = [data];
	} else {
		items = [data];
	}

	const normalized: Source[] = [];
	const seen = new Set<string>();

	for (const item of items) {
		for (const source of normalizeSourceItem(item)) {
			const url = source.url.trim();
			if (!url || seen.has(url)) continue;
			seen.add(url);
			normalized.push({ ...source, url });
		}
	}

	return normalized;
}

function normalizeSourceItem(item: unknown): Source[] {
	if (typeof item === "string") return extractUrls(item).map((url) => ({ url }));

	if (Array.isArray(item) && item.length >= 2) {
		const [title, url] = item;
		if (typeof url === "string" && /^https?:\/\//.test(url)) {
			return [
				{
					url,
					...(typeof title === "string" && title.trim() ? { title: title.trim() } : {}),
				},
			];
		}
	}

	if (isRecord(item)) {
		const url = firstString(item, ["url", "href", "link"]);
		if (!url || !/^https?:\/\//.test(url)) return [];
		const title = firstString(item, ["title", "name", "label"]);
		const description = firstString(item, ["description", "snippet", "content"]);
		return [
			{
				url,
				...(title?.trim() ? { title: title.trim() } : {}),
				...(description?.trim() ? { description: description.trim() } : {}),
			},
		];
	}

	return [];
}

function isRecord(value: unknown): value is UnknownRecord {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function firstString(record: UnknownRecord, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function mergeSources(...lists: Source[][]): Source[] {
	const seen = new Set<string>();
	const merged: Source[] = [];
	for (const list of lists) {
		for (const item of list) {
			const url = item.url?.trim();
			if (!url || seen.has(url)) continue;
			seen.add(url);
			merged.push({ ...item, url });
		}
	}
	return merged;
}

function getSettledValue<T>(
	result: PromiseSettledResult<unknown> | undefined,
	fallback: T,
): T {
	return result?.status === "fulfilled" ? (result.value as T) : fallback;
}

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.floor(value), min), max);
}

function resolveSearchControls(
	input: SearchControlInput,
	profile: SearchProfile = "auto",
): SearchControls {
	const mode = SEARCH_MODE_VALUES.includes(input.mode as SearchMode)
		? (input.mode as SearchMode)
		: "compact";
	const defaults = SEARCH_PROFILE_DEFS[profile].defaults[mode];
	return {
		mode,
		maxAnswerChars: clampNumber(input.max_answer_chars, defaults.maxAnswerChars, 0, 50000),
		maxSources: clampNumber(input.max_sources, defaults.maxSources, 0, 50),
		maxOutputBytes: clampNumber(input.max_output_bytes, defaults.maxOutputBytes, 3000, 50 * 1024),
	};
}

function limitText(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (maxChars <= 0) return { text: "", truncated: text.trim().length > 0 };
	if (text.length <= maxChars) return { text, truncated: false };
	return { text: text.slice(0, maxChars).trimEnd(), truncated: true };
}

function limitSources(sources: Source[], maxSources: number): Source[] {
	if (maxSources <= 0) return [];
	return sources.slice(0, maxSources);
}

function splitExtraSourceBudget(total: number, hasTavily: boolean, hasFirecrawl: boolean): { tavily: number; firecrawl: number } {
	const budget = clampNumber(total, 0, 0, 50);
	if (budget === 0) return { tavily: 0, firecrawl: 0 };
	if (hasTavily && hasFirecrawl) {
		const tavily = Math.ceil(budget * 0.6);
		return { tavily, firecrawl: budget - tavily };
	}
	return { tavily: hasTavily ? budget : 0, firecrawl: hasFirecrawl ? budget : 0 };
}

async function fetchAvailableModels(
	apiUrl: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<string[]> {
	if (!apiUrl || !apiKey) return [];
	const response = await fetchWithRetry(
		`${apiUrl.replace(/\/+$/, "")}/models`,
		{
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: createTimeoutSignal(10_000, signal),
		},
	);
	const data = (await response.json()) as { data?: Array<{ id?: string }> };
	return (data.data || [])
		.map((model) => model.id)
		.filter((id): id is string => typeof id === "string" && id.length > 0);
}

async function getAvailableModelsCached(
	apiUrl: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<string[]> {
	const cached = configManager.getCachedModels(apiUrl, apiKey);
	if (cached) return cached;
	try {
		const models = await fetchAvailableModels(apiUrl, apiKey, signal);
		configManager.setCachedModels(apiUrl, apiKey, models);
		return models;
	} catch (e) {
		await debugLog("models.fetch_failed", {
			apiUrl,
			error: e instanceof Error ? e.message : String(e),
		});
		return [];
	}
}

// =============================================================================
// Search API Client
// =============================================================================

async function searchWithModel(
	query: string,
	platform = "",
	signal?: AbortSignal,
	modelOverride = "",
	controls: SearchControls = resolveSearchControls({}),
	profile: SearchProfile = "auto",
): Promise<string> {
	const config = await configManager.getFullConfig();
	if (!config.searchApiUrl || !config.searchApiKey) {
		throw new Error("Search API 未配置。请使用 /search-config 命令配置。");
	}
	if (!modelOverride && !config.searchModel) {
		throw new Error("搜索模型未配置。请使用 /search-model 或 /search-config 设置模型 ID。");
	}

	const timeContext = needsTimeContext(query) ? getLocalTimeInfo() : "";
	const platformPrompt = platform
		? `\n\nYou should search the web for the information you need, and focus on these platform: ${platform}\n`
		: "";
	const effectiveModel = normalizeSearchModel(modelOverride || config.searchModel, config.searchApiUrl);
	await debugLog("search.request", {
		model: effectiveModel,
		platform,
		profile,
		hasTimeContext: !!timeContext,
	});

	const payload = {
		model: effectiveModel,
		messages: [
			{ role: "system", content: buildSearchPrompt(profile, controls) },
			{ role: "user", content: timeContext + query + platformPrompt },
		],
		stream: true,
	};

	const response = await fetchWithRetry(
		`${config.searchApiUrl.replace(/\/+$/, "")}/chat/completions`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.searchApiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
			signal,
		},
	);

	return parseStreamResponse(response);
}

async function parseStreamResponse(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("无法读取响应流");

	const decoder = new TextDecoder();
	let content = "";
	let buffer = "";
	const rawLines: string[] = [];

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				rawLines.push(trimmed);
				if (!trimmed.startsWith("data:")) continue;
				if (trimmed === "data: [DONE]" || trimmed === "data:[DONE]") continue;

				try {
					const data = JSON.parse(trimmed.slice(5).trim());
					const delta = data.choices?.[0]?.delta;
					if (delta?.content) content += delta.content;
				} catch {
					// skip malformed chunks
				}
			}
		}

		const trailing = buffer.trim();
		if (trailing) rawLines.push(trailing);
	} finally {
		reader.releaseLock();
	}

	// Fallback: non-streaming JSON or providers that buffer a full JSON object.
	if (!content && rawLines.length > 0) {
		const candidates = [rawLines.join(""), rawLines.join("\n")];
		for (const candidate of candidates) {
			try {
				const data = JSON.parse(candidate) as {
					choices?: Array<{ message?: { content?: string }; delta?: { content?: string } }>;
				};
				const choice = data.choices?.[0];
				content = choice?.message?.content || choice?.delta?.content || "";
				if (content) break;
			} catch {
				// try next candidate
			}
		}
	}

	return content;
}

// =============================================================================
// Docs Search Providers (Context7 + Exa)
// =============================================================================

interface Context7LibraryItem {
	id?: string;
	title?: string;
	description?: string;
	trustScore?: number;
	benchmarkScore?: number;
	totalSnippets?: number;
	stars?: number;
}

interface ExaResultItem {
	id?: string;
	title?: string;
	url?: string;
	publishedDate?: string;
	author?: string;
	score?: number;
	text?: string;
	highlights?: string[];
}

interface DocsSearchOptions {
	provider?: "auto" | "context7" | "exa" | "all";
	libraryId?: string;
	maxResults?: number;
	maxOutputBytes?: number;
}

function shouldUseDocsSearch(profile: SearchProfile, query: string): boolean {
	if (["coding_docs", "code_examples", "project_research"].includes(profile)) return true;
	const lower = query.toLowerCase();
	return /\b(api|sdk|docs?|documentation|reference|framework|library|github|readme|changelog|release notes?|migration|typescript|javascript|python|react|vue|next\.js|node\.js)\b/.test(lower);
}

function capabilityForTool(tool: string): Capability {
	if (tool === "docs_search") return "docs_search";
	if (tool === "web_fetch") return "web_fetch";
	if (tool === "web_map") return "site_map";
	return "main_search";
}

function context7Headers(apiKey: string): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "application/json, text/plain",
		"X-Context7-Source": "pi-search",
	};
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	return headers;
}

async function context7LibrarySearch(
	query: string,
	maxResults = 5,
	signal?: AbortSignal,
): Promise<Context7LibraryItem[]> {
	const config = await configManager.getFullConfig();
	const endpoint = `${config.context7BaseUrl.replace(/\/+$/, "")}/api/v2/search?query=${encodeURIComponent(query)}`;
	const response = await fetchWithRetry(
		endpoint,
		{
			headers: context7Headers(config.context7ApiKey),
			signal: createTimeoutSignal(DEFAULT_REQUEST_TIMEOUT_MS, signal),
		},
	);
	const data = await response.json().catch(async () => ({ content: await response.text() })) as unknown;
	const raw = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.results) ? data.results : [];
	return raw
		.filter(isRecord)
		.slice(0, maxResults)
		.map((item) => ({
			id: firstString(item, ["id"]),
			title: firstString(item, ["title", "name"]),
			description: firstString(item, ["description", "summary"]),
			trustScore: typeof item.trustScore === "number" ? item.trustScore : undefined,
			benchmarkScore: typeof item.benchmarkScore === "number" ? item.benchmarkScore : undefined,
			totalSnippets: typeof item.totalSnippets === "number" ? item.totalSnippets : undefined,
			stars: typeof item.stars === "number" ? item.stars : undefined,
		}));
}

async function context7Docs(
	libraryId: string,
	query: string,
	signal?: AbortSignal,
): Promise<unknown[]> {
	const config = await configManager.getFullConfig();
	const endpoint = `${config.context7BaseUrl.replace(/\/+$/, "")}/api/v2/context?libraryId=${encodeURIComponent(libraryId)}&query=${encodeURIComponent(query)}`;
	const response = await fetchWithRetry(
		endpoint,
		{
			headers: context7Headers(config.context7ApiKey),
			signal: createTimeoutSignal(DEFAULT_REQUEST_TIMEOUT_MS, signal),
		},
	);
	const data = await response.json().catch(async () => ({ content: await response.text() })) as unknown;
	if (!isRecord(data)) return [];
	const code = Array.isArray(data.codeSnippets) ? data.codeSnippets : [];
	const info = Array.isArray(data.infoSnippets) ? data.infoSnippets : [];
	return [...code, ...info];
}

function context7LibraryUrl(baseUrl: string, id: string | undefined): string {
	if (!id) return baseUrl.replace(/\/+$/, "");
	if (/^https?:\/\//.test(id)) return id;
	return `${baseUrl.replace(/\/+$/, "")}/${id.replace(/^\/+/, "")}`;
}

function context7LibrarySources(items: Context7LibraryItem[], baseUrl: string): Source[] {
	return items.map((item) => ({
		url: context7LibraryUrl(baseUrl, item.id),
		title: item.title || item.id || "Context7 library",
		description: item.description,
		provider: "context7",
	}));
}

function formatContext7Snippet(snippet: unknown): string {
	if (typeof snippet === "string") return snippet.slice(0, 800);
	if (!isRecord(snippet)) return JSON.stringify(snippet).slice(0, 800);
	const title = firstString(snippet, ["title", "name", "filePath"]);
	const content = firstString(snippet, ["content", "text", "description", "code"]);
	return [title ? `**${title}**` : "", content || JSON.stringify(snippet)].filter(Boolean).join("\n").slice(0, 1200);
}

async function exaSearch(
	query: string,
	maxResults = 5,
	signal?: AbortSignal,
): Promise<ExaResultItem[]> {
	const config = await configManager.getFullConfig();
	if (!config.exaApiKey) return [];
	const response = await fetchWithRetry(
		`${config.exaBaseUrl.replace(/\/+$/, "")}/search`,
		{
			method: "POST",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
				"x-api-key": config.exaApiKey,
			},
			body: JSON.stringify({
				query,
				numResults: maxResults,
				type: "neural",
				useAutoprompt: true,
				contents: { highlights: true },
			}),
			signal: createTimeoutSignal(DEFAULT_REQUEST_TIMEOUT_MS, signal),
		},
	);
	const data = await response.json() as { results?: ExaResultItem[] };
	return (data.results || []).filter((item) => item.url || item.id).slice(0, maxResults);
}

function exaSources(items: ExaResultItem[]): Source[] {
	return items.map((item) => ({
		url: item.url || item.id || "",
		title: item.title || item.url || item.id || "Exa result",
		description: item.highlights?.[0] || item.text,
		provider: "exa",
	})).filter((item) => item.url);
}

async function docsSearchSources(
	query: string,
	maxResults: number,
	signal: AbortSignal | undefined,
	attempts: ProviderAttempt[],
): Promise<Source[]> {
	const config = await configManager.getFullConfig();
	const sources: Source[] = [];
	try {
		const libraries = await withProviderAttempt(
			attempts,
			"docs_search",
			"context7",
			() => context7LibrarySearch(query, maxResults, signal),
		);
		sources.push(...context7LibrarySources(libraries, config.context7BaseUrl));
	} catch (e) {
		if (e instanceof Error && e.name === "AbortError") throw e;
	}

	if (config.exaApiKey && config.fallbackMode === "auto") {
		try {
			const exa = await withProviderAttempt(
				attempts,
				"docs_search",
				"exa",
				() => exaSearch(query, maxResults, signal),
			);
			sources.push(...exaSources(exa));
		} catch (e) {
			if (e instanceof Error && e.name === "AbortError") throw e;
		}
	}

	return limitSources(mergeSources(sources), maxResults);
}

async function runDocsSearch(
	query: string,
	options: DocsSearchOptions,
	signal?: AbortSignal,
): Promise<{ output: string; sources: Source[]; attempts: ProviderAttempt[]; capabilityStatus: CapabilityStatus[] }> {
	const config = await configManager.getFullConfig();
	const attempts: ProviderAttempt[] = [];
	const provider = options.provider || "auto";
	const maxResults = clampNumber(options.maxResults, 6, 1, 20);
	const sections: string[] = [`## Docs Search: ${query}`];
	const sources: Source[] = [];
	let context7Libraries: Context7LibraryItem[] = [];
	let context7Snippets: unknown[] = [];
	let exaResults: ExaResultItem[] = [];

	if (provider === "auto" || provider === "context7" || provider === "all") {
		try {
			context7Libraries = await withProviderAttempt(
				attempts,
				"docs_search",
				"context7",
				() => context7LibrarySearch(query, maxResults, signal),
			);
			sources.push(...context7LibrarySources(context7Libraries, config.context7BaseUrl));
			const libraryId = options.libraryId || context7Libraries.find((item) => item.id)?.id;
			if (libraryId) {
				context7Snippets = await withProviderAttempt(
					attempts,
					"docs_search",
					"context7_docs",
					() => context7Docs(libraryId, query, signal),
				);
			}
		} catch (e) {
			if (e instanceof Error && e.name === "AbortError") throw e;
		}
	}

	const shouldRunExa =
		!!config.exaApiKey &&
		(provider === "exa" || provider === "all" || (provider === "auto" && (config.fallbackMode === "auto" || sources.length === 0)));
	if (shouldRunExa) {
		try {
			exaResults = await withProviderAttempt(
				attempts,
				"docs_search",
				"exa",
				() => exaSearch(query, maxResults, signal),
			);
			sources.push(...exaSources(exaResults));
		} catch (e) {
			if (e instanceof Error && e.name === "AbortError") throw e;
		}
	}

	if (context7Libraries.length > 0) {
		sections.push("\n### Context7 libraries");
		for (const item of context7Libraries) {
			const meta = [
				item.trustScore !== undefined ? `trust=${item.trustScore}` : "",
				item.stars !== undefined ? `stars=${item.stars}` : "",
			].filter(Boolean).join(", ");
			sections.push(`- [${item.title || item.id}](${context7LibraryUrl(config.context7BaseUrl, item.id)})${meta ? ` (${meta})` : ""}${item.description ? ` — ${item.description}` : ""}`);
		}
	}
	if (context7Snippets.length > 0) {
		sections.push("\n### Context7 snippets");
		for (const snippet of context7Snippets.slice(0, 3)) sections.push(`\n${formatContext7Snippet(snippet)}`);
	}
	if (exaResults.length > 0) {
		sections.push("\n### Exa results");
		for (const item of exaResults) {
			const url = item.url || item.id || "";
			sections.push(`- [${item.title || url}](${url})${item.highlights?.[0] ? ` — ${item.highlights[0]}` : ""}`);
		}
	}
	if (sources.length === 0) sections.push("\n未返回 docs_search 结果。请检查 Context7/Exa 配置或缩小查询。");
	sections.push(...providerAttemptsMarkdown(attempts));

	return {
		output: sections.join("\n"),
		sources: mergeSources(sources),
		attempts,
		capabilityStatus: capabilityStatus(config),
	};
}

// =============================================================================
// Tavily API Client
// =============================================================================

async function tavilySearch(
	query: string,
	maxResults = 6,
	signal?: AbortSignal,
): Promise<Source[]> {
	const config = await configManager.getFullConfig();
	if (!config.tavilyApiKey) return [];

	const response = await fetchWithRetry(
		`${config.tavilyApiUrl.replace(/\/+$/, "")}/search`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.tavilyApiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query,
				max_results: maxResults,
				search_depth: "advanced",
				include_raw_content: false,
				include_answer: false,
			}),
			signal,
		},
	);

	const data = (await response.json()) as {
		results?: Array<{
			title?: string;
			url: string;
			content?: string;
			score?: number;
		}>;
	};

	return (data.results || []).map((r) => ({
		url: r.url,
		title: r.title || undefined,
		description: r.content || undefined,
		provider: "tavily",
	}));
}

async function tavilyExtract(
	url: string,
	format: WebFetchFormat = "markdown",
	signal?: AbortSignal,
): Promise<WebFetchResult | null> {
	const config = await configManager.getFullConfig();
	if (!config.tavilyApiKey || !["markdown", "text"].includes(format)) return null;

	try {
		const response = await fetchWithRetry(
			`${config.tavilyApiUrl.replace(/\/+$/, "")}/extract`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${config.tavilyApiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ urls: [url], format }),
				signal: createTimeoutSignal(DEFAULT_REQUEST_TIMEOUT_MS, signal),
			},
		);

		const data = (await response.json()) as {
			results?: Array<{ url?: string; raw_content?: string; favicon?: string }>;
		};

		const item = data.results?.[0];
		const content = item?.raw_content?.trim();
		await debugLog("tavily.extract", { url, format, success: !!content });
		if (!content) return null;
		return {
			content,
			provider: "tavily",
			format,
			metadata: {
				url,
				...(item?.url ? { finalUrl: item.url } : {}),
				...(item?.favicon ? { favicon: item.favicon } : {}),
			},
		};
	} catch (e) {
		if (e instanceof Error && e.name === "AbortError") throw e;
		await debugLog("tavily.extract_failed", { url, format, error: e instanceof Error ? e.message : String(e) });
		return null;
	}
}

async function tavilyMap(
	url: string,
	options: {
		instructions?: string;
		maxDepth?: number;
		maxBreadth?: number;
		limit?: number;
		timeout?: number;
	},
	signal?: AbortSignal,
): Promise<string> {
	const config = await configManager.getFullConfig();
	if (!config.tavilyApiKey) {
		return "配置错误: TAVILY_API_KEY 未配置，请使用 /search-config 设置 Tavily API Key。";
	}

	const timeout = options.timeout || 150;
	const timeoutSignal = AbortSignal.timeout((timeout + 10) * 1000);

	try {
		const response = await fetchWithRetry(
			`${config.tavilyApiUrl.replace(/\/+$/, "")}/map`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${config.tavilyApiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					url,
					max_depth: options.maxDepth || 1,
					max_breadth: options.maxBreadth || 10,
					limit: options.limit || 30,
					timeout,
					...(options.instructions
						? { instructions: options.instructions }
						: {}),
				}),
				signal: abortSignalAny([signal, timeoutSignal]),
			},
		);

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			return `映射失败: HTTP ${response.status} - ${text.slice(0, 200)}`;
		}

		const data = (await response.json()) as {
			base_url?: string;
			results?: string[];
			response_time?: number;
		};

		return JSON.stringify(
			{
				base_url: data.base_url || url,
				results: data.results || [],
				response_time: data.response_time || 0,
			},
			null,
			2,
		);
	} catch (e) {
		if (e instanceof Error && e.name === "AbortError") throw e;
		await debugLog("tavily.map_failed", { url, error: e instanceof Error ? e.message : String(e) });
		return `映射错误: ${e instanceof Error ? e.message : String(e)}`;
	}
}

// =============================================================================
// Firecrawl API Client
// =============================================================================

async function firecrawlSearch(
	query: string,
	limit = 14,
	signal?: AbortSignal,
): Promise<Source[]> {
	const config = await configManager.getFullConfig();
	if (!config.firecrawlApiKey) return [];

	try {
		const response = await fetchWithRetry(
			`${config.firecrawlApiUrl.replace(/\/+$/, "")}/search`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${config.firecrawlApiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ query, limit }),
				signal: createTimeoutSignal(DEFAULT_REQUEST_TIMEOUT_MS, signal),
			},
		);

		const data = (await response.json()) as {
			data?: {
				web?: Array<{ title?: string; url: string; description?: string }>;
			};
		};

		return (data.data?.web || []).map((r) => ({
			url: r.url,
			title: r.title || undefined,
			description: r.description || undefined,
			provider: "firecrawl",
		}));
	} catch (e) {
		if (e instanceof Error && e.name === "AbortError") throw e;
		await debugLog("firecrawl.search_failed", { error: e instanceof Error ? e.message : String(e) });
		return [];
	}
}

async function firecrawlScrape(
	url: string,
	format: WebFetchFormat = "markdown",
	signal?: AbortSignal,
): Promise<WebFetchResult | null> {
	const config = await configManager.getFullConfig();
	if (!config.firecrawlApiKey) return null;
	const firecrawlFormat = firecrawlFormatForWebFetch(format);
	if (!firecrawlFormat) return null;

	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const response = await fetchWithRetry(
				`${config.firecrawlApiUrl.replace(/\/+$/, "")}/scrape`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${config.firecrawlApiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						url,
						formats: [firecrawlFormat],
						timeout: 60000,
						waitFor: (attempt + 1) * 1500,
					}),
					signal: createTimeoutSignal(DEFAULT_REQUEST_TIMEOUT_MS, signal),
				},
			);

			const data = (await response.json()) as {
				data?: Record<string, unknown> & { metadata?: Record<string, unknown> };
			};

			const scraped = data.data;
			const content = typeof scraped?.[firecrawlFormat] === "string"
				? (scraped[firecrawlFormat] as string).trim()
				: "";
			if (content) {
				return {
					content,
					provider: "firecrawl",
					format,
					metadata: firecrawlMetadata(url, scraped?.metadata),
				};
			}
			await debugLog("firecrawl.scrape_empty", { url, format, attempt: attempt + 1 });
		} catch (e) {
			if (e instanceof Error && e.name === "AbortError") throw e;
			await debugLog("firecrawl.scrape_failed", {
				url,
				format,
				attempt: attempt + 1,
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	return null;
}

function firecrawlFormatForWebFetch(format: WebFetchFormat): "markdown" | "html" | "rawHtml" | null {
	if (format === "markdown" || format === "html") return format;
	if (format === "raw") return "rawHtml";
	return null;
}

function firecrawlMetadata(url: string, metadata: Record<string, unknown> | undefined): WebFetchMetadata {
	return {
		url,
		...stringField(metadata, "sourceURL", "finalUrl"),
		...stringField(metadata, "url", "finalUrl"),
		...numberField(metadata, "statusCode", "status"),
		...stringField(metadata, "contentType", "contentType"),
		...stringField(metadata, "title", "title"),
		...stringField(metadata, "description", "description"),
		...stringField(metadata, "language", "language"),
	};
}

function stringField<T extends keyof WebFetchMetadata>(
	record: Record<string, unknown> | undefined,
	from: string,
	to: T,
): Partial<WebFetchMetadata> {
	const value = record?.[from];
	return typeof value === "string" && value.trim()
		? ({ [to]: value.trim() } as Partial<WebFetchMetadata>)
		: {};
}

function numberField<T extends keyof WebFetchMetadata>(
	record: Record<string, unknown> | undefined,
	from: string,
	to: T,
): Partial<WebFetchMetadata> {
	const value = record?.[from];
	return typeof value === "number" && Number.isFinite(value)
		? ({ [to]: value } as Partial<WebFetchMetadata>)
		: {};
}

function normalizeWebFetchFormat(value: unknown): WebFetchFormat {
	return WEB_FETCH_FORMAT_VALUES.includes(value as WebFetchFormat)
		? (value as WebFetchFormat)
		: "markdown";
}

function normalizeWebFetchProviderChoice(value: unknown): WebFetchProviderChoice {
	return WEB_FETCH_PROVIDER_VALUES.includes(value as WebFetchProviderChoice)
		? (value as WebFetchProviderChoice)
		: "auto";
}

function normalizeHttpUrl(value: string): string {
	const url = new URL(value);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("web_fetch 只支持 HTTP/HTTPS URL");
	}
	return url.href;
}

function resolveSmartDirectOptions(params: Record<string, unknown>): SmartDirectOptions {
	return {
		browser: stringParam(params.browser, SMART_DIRECT_DEFAULT_BROWSER),
		os: stringParam(params.os, SMART_DIRECT_DEFAULT_OS),
		timeoutMs: clampNumber(params.timeout_ms as number | undefined, SMART_DIRECT_DEFAULT_TIMEOUT_MS, 1000, DEFAULT_REQUEST_TIMEOUT_MS),
		maxChars: clampNumber(params.maxChars as number | undefined, SMART_DIRECT_DEFAULT_MAX_CHARS, 1000, 200_000),
		headers: normalizeHeaderRecord(params.headers),
		removeImages: booleanParam(params.remove_images, false),
		includeReplies: normalizeIncludeReplies(params.include_replies),
		...(typeof params.proxy === "string" && params.proxy.trim() ? { proxy: params.proxy.trim() } : {}),
		verbose: booleanParam(params.verbose, false),
	};
}

function stringParam(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function booleanParam(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function normalizeIncludeReplies(value: unknown): SmartFetchIncludeReplies {
	if (typeof value === "boolean") return value;
	return value === "extractors" ? "extractors" : SMART_DIRECT_DEFAULT_INCLUDE_REPLIES;
}

function normalizeHeaderRecord(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	const headers: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (!key.trim()) continue;
		if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
			headers[key] = String(raw);
		}
	}
	return headers;
}

function smartDirectSupported(format: WebFetchFormat): boolean {
	return format === "markdown" || format === "html" || format === "text";
}

async function smartDirectFetch(
	url: string,
	format: WebFetchFormat,
	options: SmartDirectOptions,
	signal?: AbortSignal,
): Promise<WebFetchResult | null> {
	if (!smartDirectSupported(format)) return null;
	const targetUrl = normalizeHttpUrl(url);
	try {
		const response = await wreqFetch(targetUrl, {
			browser: options.browser as BrowserProfile,
			os: options.os as EmulationOS,
			headers: {
				Accept: SMART_DIRECT_ACCEPT,
				"Accept-Language": SMART_DIRECT_ACCEPT_LANGUAGE,
				...options.headers,
			},
			redirect: "follow",
			timeout: options.timeoutMs,
			...(options.proxy ? { proxy: options.proxy } : {}),
			signal: createTimeoutSignal(options.timeoutMs, signal),
		} satisfies WreqRequestInit);

		const metadata = smartDirectMetadata(targetUrl, response, options);
		if (!response.ok) {
			await debugLog("smart_direct.http_failed", { url, status: response.status });
			return null;
		}
		if (!isSmartDirectContent(metadata.contentType)) {
			await debugLog("smart_direct.unsupported_content", { url, contentType: metadata.contentType });
			return null;
		}

		const html = await response.text();
		if (!html.trim()) return null;
		const finalUrl = metadata.finalUrl || targetUrl;
		const document = parseSmartDirectHtml(html, finalUrl);
		const extracted = await Defuddle(document, finalUrl, {
			markdown: format !== "html",
			removeImages: options.removeImages,
			includeReplies: options.includeReplies,
		});
		if (!extracted.content || extracted.wordCount === 0) {
			await debugLog("smart_direct.empty_extract", { url, finalUrl });
			return null;
		}

		Object.assign(metadata, smartDirectExtractedMetadata(extracted, options));
		const normalized = format === "text" ? markdownToPlainText(extracted.content) : extracted.content;
		const limited = normalized.slice(0, options.maxChars).trim();
		const content = formatSmartDirectContent(limited, metadata, options.verbose);
		return { content, provider: "smart_direct", format, metadata };
	} catch (e) {
		if (e instanceof Error && e.name === "AbortError") throw e;
		await debugLog("smart_direct.fetch_failed", {
			url,
			format,
			error: e instanceof Error ? e.message : String(e),
		});
		return null;
	}
}

function isSmartDirectContent(contentType: string | undefined): boolean {
	if (!contentType) return true;
	const lower = contentType.toLowerCase();
	return lower.includes("text/html") || lower.includes("application/xhtml+xml") || lower.includes("text/plain") || lower.includes("text/markdown");
}

function smartDirectMetadata(url: string, response: { url?: string; status?: number; headers: { get(name: string): string | null } }, options: SmartDirectOptions): WebFetchMetadata {
	const contentLength = parseContentLength(response.headers.get("content-length"));
	const contentType = response.headers.get("content-type") || undefined;
	return {
		url,
		...(response.url ? { finalUrl: response.url } : {}),
		...(typeof response.status === "number" ? { status: response.status } : {}),
		...(contentType ? { contentType } : {}),
		...(contentLength !== null ? { contentLength } : {}),
		browser: options.browser,
		os: options.os,
	};
}

function parseSmartDirectHtml(html: string, url: string): Document {
	const { document } = parseHTML(html);
	const doc = document as unknown as {
		styleSheets?: unknown;
		URL?: string;
		defaultView?: { getComputedStyle?: () => CSSStyleDeclaration };
	};
	if (!doc.styleSheets) doc.styleSheets = [];
	if (doc.defaultView && !doc.defaultView.getComputedStyle) {
		doc.defaultView.getComputedStyle = () => ({ display: "" } as unknown as CSSStyleDeclaration);
	}
	doc.URL = url;
	return document;
}

function smartDirectExtractedMetadata(extracted: DefuddleResponse, options: SmartDirectOptions): Partial<WebFetchMetadata> {
	return {
		...(extracted.title ? { title: extracted.title } : {}),
		...(extracted.description ? { description: extracted.description } : {}),
		...(extracted.author ? { author: extracted.author } : {}),
		...(extracted.published ? { published: extracted.published } : {}),
		...(extracted.site ? { site: extracted.site } : {}),
		...(extracted.language ? { language: extracted.language } : {}),
		...(extracted.favicon ? { favicon: extracted.favicon } : {}),
		...(typeof extracted.wordCount === "number" ? { wordCount: extracted.wordCount } : {}),
		browser: options.browser,
		os: options.os,
	};
}

function formatSmartDirectContent(content: string, metadata: WebFetchMetadata, verbose: boolean): string {
	const headerFields: Array<[string, string | number | undefined]> = verbose
		? [
			["URL", metadata.finalUrl || metadata.url],
			["Title", metadata.title],
			["Author", metadata.author],
			["Published", metadata.published],
			["Site", metadata.site],
			["Language", metadata.language],
			["Words", metadata.wordCount],
			["Browser", metadata.browser && metadata.os ? `${metadata.browser}/${metadata.os}` : undefined],
		]
		: [
			["URL", metadata.finalUrl || metadata.url],
			["Title", metadata.title],
			["Author", metadata.author],
			["Published", metadata.published],
		];
	const header = headerFields
		.filter(([, value]) => value !== undefined && value !== "")
		.map(([label, value]) => `> ${label}: ${value}`)
		.join("\n");
	return header ? `${header}\n\n${content}`.trim() : content.trim();
}

function markdownToPlainText(markdown: string): string {
	return markdown
		.replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ""))
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/[*_~`>#-]+/g, " ")
		.replace(/[ \t]+/g, " ")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.join("\n");
}

async function directFetch(
	url: string,
	format: WebFetchFormat,
	maxOutputBytes: number,
	signal?: AbortSignal,
	redirectDepth = 0,
	seen = new Set<string>(),
): Promise<WebFetchResult | null> {
	const targetUrl = normalizeHttpUrl(url);
	if (seen.has(targetUrl)) return null;
	seen.add(targetUrl);

	try {
		const response = await fetch(targetUrl, {
			headers: directFetchHeaders(),
			redirect: "follow",
			signal: createTimeoutSignal(DEFAULT_REQUEST_TIMEOUT_MS, signal),
		});
		const metadata = metadataFromResponse(targetUrl, response);
		if (!isTextLikeContent(metadata.contentType)) {
			return {
				content: noBodyNotice(metadata, "目标看起来是二进制或附件，未把正文注入上下文。"),
				provider: "direct",
				format,
				metadata,
			};
		}
		if (isLargeBody(metadata)) {
			return {
				content: noBodyNotice(metadata, "目标正文过大，未把正文注入上下文。请缩小 URL 范围或明确提高预算后重试。"),
				provider: "direct",
				format,
				metadata,
			};
		}

		const inputLimit = Math.min(
			Math.max(maxOutputBytes * 4, DIRECT_FETCH_MIN_INPUT_BYTES),
			DIRECT_FETCH_MAX_INPUT_BYTES,
		);
		const body = await readTextPreview(response, inputLimit);
		let content = body.text.trim();
		if (!content) return {
			content: noBodyNotice(metadata, "目标响应没有可注入的文本正文。"),
			provider: "direct",
			format,
			metadata,
		};

		const html = isHtmlContent(metadata.contentType, content);
		if (html) {
			Object.assign(metadata, extractHtmlMetadata(content, metadata.finalUrl || targetUrl));
			if (redirectDepth < 2) {
				const refreshUrl = findMetaRefreshUrl(content, metadata.finalUrl || targetUrl);
				if (refreshUrl && !seen.has(refreshUrl)) {
					return directFetch(refreshUrl, format, maxOutputBytes, signal, redirectDepth + 1, seen);
				}
			}

			if (format !== "raw" && redirectDepth < 2) {
				const readable = htmlToReadableText(content);
				if (readable.length < 500) {
					const alternateUrl = findAlternateUrl(content, metadata.finalUrl || targetUrl, format);
					if (alternateUrl && !seen.has(alternateUrl)) {
						return directFetch(alternateUrl, format, maxOutputBytes, signal, redirectDepth + 1, seen);
					}
				}
			}
		}

		content = renderDirectContent(content, format, metadata, body.truncated, inputLimit);
		return { content, provider: "direct", format, metadata };
	} catch (e) {
		if (e instanceof Error && e.name === "AbortError") throw e;
		await debugLog("direct.fetch_failed", {
			url,
			format,
			error: e instanceof Error ? e.message : String(e),
		});
		return null;
	}
}

function directFetchHeaders(): Record<string, string> {
	return {
		"User-Agent":
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
		Accept:
			"text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/plain;q=0.8,*/*;q=0.5",
		"Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
		"Cache-Control": "no-cache",
		Pragma: "no-cache",
	};
}

function metadataFromResponse(url: string, response: Response): WebFetchMetadata {
	const contentLength = parseContentLength(response.headers.get("content-length"));
	const contentType = response.headers.get("content-type") || undefined;
	const contentDisposition = response.headers.get("content-disposition") || undefined;
	return {
		url,
		...(response.url ? { finalUrl: response.url } : {}),
		status: response.status,
		...(contentType ? { contentType } : {}),
		...(contentDisposition ? { contentDisposition } : {}),
		...(contentLength !== null ? { contentLength } : {}),
	};
}

function parseContentLength(value: string | null): number | null {
	if (!value) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isTextLikeContent(contentType: string | undefined): boolean {
	if (!contentType) return true;
	const type = contentType.toLowerCase();
	return (
		type.startsWith("text/") ||
		type.includes("json") ||
		type.includes("xml") ||
		type.includes("javascript") ||
		type.includes("typescript") ||
		type.includes("markdown") ||
		type.includes("yaml") ||
		type.includes("x-www-form-urlencoded") ||
		type.includes("svg")
	);
}

function isLargeBody(metadata: WebFetchMetadata): boolean {
	return (
		(metadata.contentLength !== undefined && metadata.contentLength > DIRECT_FETCH_LARGE_BODY_BYTES) ||
		!!metadata.contentDisposition?.toLowerCase().includes("attachment")
	);
}

function isHtmlContent(contentType: string | undefined, content: string): boolean {
	return !!contentType?.toLowerCase().includes("html") || /^\s*<!doctype html/i.test(content) || /^\s*<html[\s>]/i.test(content);
}

async function readTextPreview(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
	const reader = response.body?.getReader();
	if (!reader) return { text: await response.text(), truncated: false };

	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	let truncated = false;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		const remaining = maxBytes - bytes;
		if (remaining <= 0) {
			truncated = true;
			await reader.cancel().catch(() => undefined);
			break;
		}
		const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
		text += decoder.decode(chunk, { stream: true });
		bytes += chunk.byteLength;
		if (value.byteLength > remaining) {
			truncated = true;
			await reader.cancel().catch(() => undefined);
			break;
		}
	}

	text += decoder.decode();
	return { text, truncated };
}

function noBodyNotice(metadata: WebFetchMetadata, reason: string): string {
	const lines = [`## 未注入正文`, "", reason, ""];
	lines.push(`- URL: ${metadata.finalUrl || metadata.url}`);
	if (metadata.status) lines.push(`- Status: ${metadata.status}`);
	if (metadata.contentType) lines.push(`- Content-Type: ${metadata.contentType}`);
	if (metadata.contentLength !== undefined) lines.push(`- Content-Length: ${formatSize(metadata.contentLength)}`);
	if (metadata.contentDisposition) lines.push(`- Content-Disposition: ${metadata.contentDisposition}`);
	return lines.join("\n");
}

function renderDirectContent(
	content: string,
	format: WebFetchFormat,
	metadata: WebFetchMetadata,
	inputTruncated: boolean,
	inputLimit: number,
): string {
	const html = isHtmlContent(metadata.contentType, content);
	let output = content;
	if (format === "markdown") {
		output = html ? htmlToMarkdownPreview(content, metadata) : content;
	} else if (format === "text") {
		output = html ? htmlToReadableText(content) : content;
	} else if (format === "json") {
		output = prettyJsonOrText(content);
	}
	if (inputTruncated) {
		output += `\n\n[Direct fetch input truncated at ${formatSize(inputLimit)} before formatting.]`;
	}
	return output.trim();
}

function prettyJsonOrText(content: string): string {
	try {
		return JSON.stringify(JSON.parse(content), null, 2);
	} catch {
		return content;
	}
}

function htmlToMarkdownPreview(html: string, metadata: WebFetchMetadata): string {
	const text = htmlToReadableText(html);
	if (!metadata.title) return text;
	return `# ${metadata.title}\n\n${text.replace(new RegExp(`^${escapeRegExp(metadata.title)}\\s*`), "").trim()}`.trim();
}

function htmlToReadableText(html: string): string {
	return decodeHtmlEntities(
		html
			.replace(/<script\b[\s\S]*?<\/script>/gi, "\n")
			.replace(/<style\b[\s\S]*?<\/style>/gi, "\n")
			.replace(/<!--[\s\S]*?-->/g, "\n")
			.replace(/<(?:br|hr)\s*\/?>/gi, "\n")
			.replace(/<\/(?:p|div|section|article|header|footer|main|nav|aside|li|h[1-6]|tr)>/gi, "\n")
			.replace(/<[^>]+>/g, " ")
	)
		.split(/\r?\n/)
		.map((line) => line.replace(/[ \t]+/g, " ").trim())
		.filter(Boolean)
		.join("\n");
}

function extractHtmlMetadata(html: string, baseUrl: string): Partial<WebFetchMetadata> {
	return {
		...firstHtmlMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i, "title"),
		...metaContent(html, "description", "description"),
		...metaContent(html, "og:description", "description"),
		...linkHref(html, "canonical", "canonicalUrl", baseUrl),
		...htmlLang(html),
	};
}

function firstHtmlMatch<T extends keyof WebFetchMetadata>(html: string, pattern: RegExp, key: T): Partial<WebFetchMetadata> {
	const value = html.match(pattern)?.[1];
	return value?.trim()
		? ({ [key]: decodeHtmlEntities(value.replace(/<[^>]+>/g, " ").trim()) } as Partial<WebFetchMetadata>)
		: {};
}

function metaContent<T extends keyof WebFetchMetadata>(html: string, name: string, key: T): Partial<WebFetchMetadata> {
	for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
		const attrs = parseHtmlAttributes(tag[0]);
		const attrName = (attrs.name || attrs.property || "").toLowerCase();
		if (attrName === name.toLowerCase() && attrs.content?.trim()) {
			return { [key]: decodeHtmlEntities(attrs.content.trim()) } as Partial<WebFetchMetadata>;
		}
	}
	return {};
}

function linkHref<T extends keyof WebFetchMetadata>(html: string, rel: string, key: T, baseUrl: string): Partial<WebFetchMetadata> {
	for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
		const attrs = parseHtmlAttributes(tag[0]);
		const rels = (attrs.rel || "").toLowerCase().split(/\s+/);
		if (rels.includes(rel.toLowerCase()) && attrs.href?.trim()) {
			try {
				return { [key]: new URL(attrs.href.trim(), baseUrl).href } as Partial<WebFetchMetadata>;
			} catch {
				continue;
			}
		}
	}
	return {};
}

function htmlLang(html: string): Partial<WebFetchMetadata> {
	const match = html.match(/<html\b[^>]*\blang=["']?([^"'\s>]+)/i);
	return match?.[1] ? { language: match[1] } : {};
}

function findMetaRefreshUrl(html: string, baseUrl: string): string | null {
	for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
		const attrs = parseHtmlAttributes(tag[0]);
		if ((attrs["http-equiv"] || "").toLowerCase() !== "refresh") continue;
		const content = attrs.content || "";
		const delay = Number(content.split(";")[0]?.trim() || "0");
		if (Number.isFinite(delay) && delay > 5) continue;
		const urlMatch = content.match(/url\s*=\s*([^;]+)/i);
		const refreshUrl = urlMatch?.[1]?.trim().replace(/^['"]|['"]$/g, "");
		if (!refreshUrl) continue;
		try {
			return normalizeHttpUrl(new URL(refreshUrl, baseUrl).href);
		} catch {
			continue;
		}
	}
	return null;
}

function findAlternateUrl(html: string, baseUrl: string, format: WebFetchFormat): string | null {
	const acceptedTypes: Record<WebFetchFormat, string[]> = {
		markdown: ["text/markdown", "text/x-markdown", "text/plain"],
		text: ["text/plain"],
		html: ["text/html", "application/xhtml+xml"],
		json: ["application/json"],
		raw: [],
	};
	const accepted = acceptedTypes[format];
	if (accepted.length === 0) return null;
	for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
		const attrs = parseHtmlAttributes(tag[0]);
		const rels = (attrs.rel || "").toLowerCase().split(/\s+/);
		const type = (attrs.type || "").toLowerCase().split(";")[0].trim();
		if (!rels.includes("alternate") || !accepted.includes(type) || !attrs.href?.trim()) continue;
		try {
			return normalizeHttpUrl(new URL(attrs.href.trim(), baseUrl).href);
		} catch {
			continue;
		}
	}
	return null;
}

function parseHtmlAttributes(tag: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	for (const match of tag.matchAll(/([\w:-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g)) {
		const name = match[1]?.toLowerCase();
		if (!name) continue;
		const raw = match[2] || "";
		attrs[name] = decodeHtmlEntities(raw.replace(/^['"]|['"]$/g, ""));
	}
	return attrs;
}

function decodeHtmlEntities(text: string): string {
	const named: Record<string, string> = {
		amp: "&",
		lt: "<",
		gt: ">",
		quot: '"',
		apos: "'",
		nbsp: " ",
	};
	return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
		const lower = entity.toLowerCase();
		if (lower[0] === "#") {
			const code = lower[1] === "x" ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : match;
		}
		return named[lower] || match;
	});
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseJsonContent(content: string): unknown {
	try {
		return JSON.parse(content);
	} catch {
		return content;
	}
}

async function finishWebFetchResult(
	result: WebFetchResult,
	maxOutputBytes: number,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
	if (result.format === "json") return finishJsonWebFetchResult(result, maxOutputBytes);

	const output = await truncateToolOutput(result.content, `web-fetch-${result.provider}`, {
		maxBytes: maxOutputBytes,
		extension: extensionForOutputFormat(result.format),
	});
	const { content, ...outputDetails } = output;
	return {
		content: [{ type: "text", text: content }],
		details: webFetchDetails(result, outputDetails),
	};
}

async function finishJsonWebFetchResult(
	result: WebFetchResult,
	maxOutputBytes: number,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
	const overhead = JSON.stringify({
		url: result.metadata.url,
		final_url: result.metadata.finalUrl,
		provider: result.provider,
		format: result.format,
		metadata: result.metadata,
		content: "",
		truncated: false,
		full_output_path: undefined,
	}, null, 2);
	const contentBudget = Math.max(1000, maxOutputBytes - Buffer.byteLength(overhead, "utf8") - 200);
	const truncatedContent = truncateText(result.content, { maxBytes: contentBudget });
	const fullOutputPath = truncatedContent.truncated
		? await saveFullOutput(`web-fetch-${result.provider}`, result.content, "json")
		: null;
	const payload = {
		url: result.metadata.url,
		final_url: result.metadata.finalUrl,
		provider: result.provider,
		format: result.format,
		metadata: result.metadata,
		content: parseJsonContent(truncatedContent.content),
		truncated: truncatedContent.truncated,
		output_bytes: truncatedContent.outputBytes,
		total_bytes: truncatedContent.totalBytes,
		output_lines: truncatedContent.outputLines,
		total_lines: truncatedContent.totalLines,
		...(fullOutputPath ? { full_output_path: fullOutputPath } : {}),
	};
	return {
		content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
		details: webFetchDetails(result, {
			truncated: truncatedContent.truncated,
			fullOutputPath: fullOutputPath || undefined,
			outputBytes: truncatedContent.outputBytes,
			totalBytes: truncatedContent.totalBytes,
			outputLines: truncatedContent.outputLines,
			totalLines: truncatedContent.totalLines,
		}),
	};
}

function webFetchDetails(result: WebFetchResult, outputDetails: Record<string, unknown>): Record<string, unknown> {
	return {
		url: result.metadata.url,
		final_url: result.metadata.finalUrl,
		provider: result.provider,
		format: result.format,
		metadata: result.metadata,
		...outputDetails,
	};
}

function fetchFailure(
	url: string,
	format: WebFetchFormat,
	providerChoice: WebFetchProviderChoice,
	config: RuntimeConfig,
	attempts: ProviderAttempt[],
): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
	return {
		content: [
			{
				type: "text",
				text: `提取失败: provider=${providerChoice} 未能获取可注入的文本内容。可尝试 provider=auto、换用 search 搜索，或缩小 URL 范围。`,
			},
		],
		details: {
			url,
			format,
			provider_choice: providerChoice,
			error: attempts.length === 0 ? "provider_not_configured_or_unsupported" : "all_failed",
			...capabilityDiagnostics(config, attempts, "web_fetch"),
		},
	};
}

// =============================================================================
// Prompts
// =============================================================================

const searchConfigParameters = Type.Object({
	action: StringEnum(["show", "set", "test"] as const),
	key: Type.Optional(
		StringEnum([
			"searchApiUrl",
			"searchApiKey",
			"model",
			"searchProfile",
			"fallbackMode",
			"minimumProfile",
			"tavilyApiKey",
			"tavilyApiUrl",
			"firecrawlApiKey",
			"firecrawlApiUrl",
			"context7ApiKey",
			"context7BaseUrl",
			"exaApiKey",
			"exaBaseUrl",
		] as const),
	),
	value: Type.Optional(Type.String()),
});

const SEARCH_PROMPT_BASE = `# Core Instruction

1. Infer the user's intent from the query, but do not broaden the task unless necessary.
2. Verify factual claims with authoritative sources before answering.
3. Prefer official documentation, academic databases, reputable media, and primary sources.
4. Cite sources at paragraph or table-row level. Do not cite every sentence.
5. Be concise and stay within the output budget.

# Output Style

1. Lead with the most probable answer or solution.
2. Use polished Markdown.
3. Define technical terms only when they are necessary for understanding.
4. State limitations when evidence is incomplete or conflicting.
`;

function buildSearchPrompt(profile: SearchProfile, controls: SearchControls): string {
	const sourceLimit = controls.maxSources > 0
		? `Return at most ${controls.maxSources} source links in the final source/reference block.`
		: "Do not include a final source/reference block.";
	const answerLimit = controls.maxAnswerChars > 0
		? `Keep the answer under ${controls.maxAnswerChars} characters.`
		: "Do not write a prose answer; return only source links with terse labels.";
	const modeInstruction: Record<SearchMode, string> = {
		compact:
			"Mode: compact. Return a short answer, key evidence, and only the most relevant sources.",
		normal:
			"Mode: normal. Return a complete but bounded answer with concise evidence and sources.",
		deep:
			"Mode: deep. Explore multiple angles, but still respect the output budget and avoid unnecessary background.",
		sources_only:
			"Mode: sources_only. Do not synthesize a long answer. Return the most relevant sources with one-line relevance notes.",
	};

	return `${SEARCH_PROMPT_BASE}\n${SEARCH_PROFILE_DEFS[profile].searchPrompt}\n\n# Search Budget\n\n${modeInstruction[controls.mode]}\n${answerLimit}\n${sourceLimit}\n`;
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	// =========================================================================
	// Tool: search — AI 网络搜索
	// =========================================================================
	pi.on("before_agent_start", async (_event, _ctx) => {
		const config = await configManager.getFullConfig();
		return {
			systemPrompt: `${_event.systemPrompt}\n\n${SEARCH_PROFILE_DEFS[config.searchProfile].lightPrompt}\n${WEB_FETCH_LIGHT_PROMPT}`,
		};
	});

	pi.registerTool({
		name: "search",
		label: "Pi Search",
		description:
			"通过 OpenAI-compatible Search API 执行 AI 驱动的深度网络搜索。自动检测时间相关查询并注入时间上下文。\n" +
			"返回受预算控制的搜索结果正文和 session_id（用于 search_sources 获取信源）。\n" +
			"默认 compact 模式，适用：查找技术文档、API 规范、开源项目、pi Extension 开发指南等。",
		promptSnippet:
			"通过 OpenAI-compatible Search API 执行 AI 深度网络搜索（文档、API、开源项目等）",
		promptGuidelines: [
			"Use search when external, recent, or authoritative web information is needed.",
			"Search queries to search should be in English when possible; answer the user in Chinese unless requested otherwise.",
			"Prefer the active search profile; pass profile explicitly only when the user asks for a different search style.",
			"For programming tasks, prefer official docs and GitHub sources; use web_fetch only for selected high-value pages.",
			"Avoid injecting long web pages into context; prefer compact results, source lists, and targeted fetches.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "搜索查询，清晰、自包含的自然语言问题",
			}),
			platform: Type.Optional(
				Type.String({
					description:
						'聚焦平台，如 "Twitter", "GitHub, Reddit"。留空为全网搜索。',
				}),
			),
			extra_sources: Type.Optional(
				Type.Number({
					description:
						"额外补充信源总预算（Tavily/Firecrawl 共享），0 为关闭。默认 0。",
					minimum: 0,
					maximum: 50,
				}),
			),
			profile: Type.Optional(
				StringEnum(SEARCH_PROFILE_VALUES, {
					description:
						"搜索场景预设。默认使用 /search-config 中保存的全局模式。",
				}),
			),
			mode: Type.Optional(
				StringEnum(["compact", "normal", "deep", "sources_only"] as const, {
					description: "输出模式。默认 compact；deep 仅用于明确要求深度研究。",
				}),
			),
			max_answer_chars: Type.Optional(
				Type.Number({
					description: "答案正文最大字符数。按 mode 有默认值。",
					minimum: 0,
					maximum: 50000,
				}),
			),
			max_sources: Type.Optional(
				Type.Number({
					description: "本次返回的最大信源数量。完整信源仍缓存到 session_id。",
					minimum: 0,
					maximum: 50,
				}),
			),
			max_output_bytes: Type.Optional(
				Type.Number({
					description: "工具返回内容最大字节数。默认按 mode 控制。",
					minimum: 3000,
					maximum: 51200,
				}),
			),
			model: Type.Optional(
				Type.String({
					description: "可选模型 ID，仅本次请求生效。留空使用全局配置模型。",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const config = await configManager.getFullConfig();
			const effectiveModel = normalizeSearchModel(params.model || config.searchModel, config.searchApiUrl);
			const profile = parseSearchProfile(params.profile) || config.searchProfile;
			const controls = resolveSearchControls(params, profile);
			const endStatus = beginStatus(ctx, formatSearchStatus(effectiveModel));
			onUpdate?.({ content: [{ type: "text", text: "🔍 正在搜索..." }], details: {} });

			try {
				const sessionId = newSessionId();

				// Parallel: Search Model search + optional Tavily/Firecrawl
				const hasTavily = !!config.tavilyApiKey;
				const hasFirecrawl = !!config.firecrawlApiKey;
				const extraBudget = splitExtraSourceBudget(params.extra_sources || 0, hasTavily, hasFirecrawl);

				if (params.model && config.searchApiUrl && config.searchApiKey) {
					const models = await getAvailableModelsCached(
						config.searchApiUrl,
						config.searchApiKey,
						signal,
					);
					if (models.length > 0 && !models.includes(effectiveModel)) {
						throw new Error(`无效模型: ${effectiveModel}`);
					}
				}

				const attempts: ProviderAttempt[] = [];
				const tasks: Promise<unknown>[] = [
					withProviderAttempt(
						attempts,
						"main_search",
						"openai_compatible",
						() => searchWithModel(params.query, params.platform || "", signal, effectiveModel, controls, profile),
					),
				];

				if (extraBudget.tavily > 0) {
					tasks.push(withOptionalProviderAttempt(
						attempts,
						"web_search",
						"tavily",
						async () => {
							const sources = await tavilySearch(params.query, extraBudget.tavily, signal);
							return sources.length > 0 ? sources : null;
						},
					));
				}
				if (extraBudget.firecrawl > 0) {
					tasks.push(withOptionalProviderAttempt(
						attempts,
						"web_search",
						"firecrawl",
						async () => {
							const sources = await firecrawlSearch(params.query, extraBudget.firecrawl, signal);
							return sources.length > 0 ? sources : null;
						},
					));
				}
				const docsSearchEnabled = controls.maxSources > 0 && config.fallbackMode === "auto" && shouldUseDocsSearch(profile, params.query);
				if (docsSearchEnabled) {
					tasks.push(docsSearchSources(params.query, Math.min(controls.maxSources || 6, 8), signal, attempts));
				}

				const results = await Promise.allSettled(tasks);

				if (results[0]?.status === "rejected") {
					if (results.length === 1) throw results[0].reason;
					await debugLog("search.primary_failed", {
						error: results[0].reason instanceof Error ? results[0].reason.message : String(results[0].reason),
					});
				}

				const primaryResult = getSettledValue<string>(results[0], "");
				let resultIndex = 1;
				const tavilySources =
					extraBudget.tavily > 0
						? (getSettledValue<Source[] | null>(results[resultIndex++], null) ?? [])
						: [];
				const firecrawlSources =
					extraBudget.firecrawl > 0
						? (getSettledValue<Source[] | null>(results[resultIndex++], null) ?? [])
						: [];
				const docsSources = docsSearchEnabled
					? getSettledValue<Source[]>(results[resultIndex], [])
					: [];

				// Parse Search Model response
				const { answer, sources: primarySources } =
					splitAnswerAndSources(primaryResult);
				const allSources = mergeSources(
					primarySources,
					docsSources,
					tavilySources,
					firecrawlSources,
				);

				// Cache sources
				sourcesCache.set(sessionId, allSources);

				// Build output
				const limitedAnswer = limitText(answer, controls.maxAnswerChars);
				const visibleSources = limitSources(allSources, controls.maxSources);
				let output = limitedAnswer.text;
				if (limitedAnswer.truncated) {
					output += `\n\n[Answer truncated to ${controls.maxAnswerChars} characters. Use narrower queries or mode=deep for a larger budget.]`;
				}
				if (!primaryResult && allSources.length > 0) {
					output = "⚠️ 搜索模型主搜索失败，仅返回补充信源。";
				}
				if (visibleSources.length > 0) {
					output += `\n\n---\n**信源 (${visibleSources.length}/${allSources.length})** | session_id: \`${sessionId}\`\n`;
					for (const s of visibleSources) {
						output += s.title ? `- [${s.title}](${s.url})\n` : `- ${s.url}\n`;
					}
					if (allSources.length > visibleSources.length) {
						output += `- ... 还有 ${allSources.length - visibleSources.length} 个信源，使用 search_sources 分页获取\n`;
					}
				} else if (allSources.length > 0) {
					output += `\n\n---\n**信源已缓存 (${allSources.length})** | session_id: \`${sessionId}\`，使用 search_sources 分页获取\n`;
				}
				if (!output.trim()) output = "未返回可显示内容。请尝试 normal/deep 模式或缩小查询。";

				const finalOutput = await truncateToolOutput(output, "search", { maxBytes: controls.maxOutputBytes });
				const { content, ...outputDetails } = finalOutput;
				return {
					content: [{ type: "text", text: content }],
					details: {
						session_id: sessionId,
						sources_count: allSources.length,
						returned_sources_count: visibleSources.length,
						answer_chars: answer.length,
						profile,
						mode: controls.mode,
						model: effectiveModel,
						docs_search_enriched: docsSources.length > 0,
						...capabilityDiagnostics(config, attempts),
						...outputDetails,
					},
				};
			} catch (e) {
				throw new Error(
					`搜索失败: ${e instanceof Error ? e.message : String(e)}`,
				);
			} finally {
				endStatus();
			}
		},
	});

	// =========================================================================
	// Tool: docs_search — Context7 + Exa 文档检索
	// =========================================================================
	pi.registerTool({
		name: "docs_search",
		label: "Docs Search",
		description:
			"通过 Context7 和 Exa 检索官方文档、SDK/API、框架资料、GitHub 与高可信技术来源。\n" +
			"适用于 coding_docs、code_examples、project_research 等场景；返回内容和 session_id（用于 search_sources 获取完整信源）。",
		promptSnippet: "Context7 + Exa 官方文档/API/GitHub 检索",
		promptGuidelines: [
			"Use docs_search for SDK/API/framework documentation, official docs, changelog, migration, GitHub project and code examples.",
			"Prefer Context7 for library/API docs and Exa for official domains, GitHub, papers, product docs and trusted source discovery.",
			"Use web_fetch on selected high-value URLs before citing detailed claims.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "文档/API/框架/GitHub 检索查询" }),
			provider: Type.Optional(
				StringEnum(["auto", "context7", "exa", "all"] as const, {
					description: "provider 选择。auto 默认 Context7，配置 Exa 且允许 fallback 时补充 Exa。",
				}),
			),
			library_id: Type.Optional(Type.String({ description: "Context7 libraryId；留空时自动使用首个库结果" })),
			max_results: Type.Optional(Type.Number({ description: "最大结果数（1-20），默认 6", minimum: 1, maximum: 20 })),
			max_output_bytes: Type.Optional(Type.Number({ description: "返回内容最大字节数，默认 12000", minimum: 3000, maximum: 51200 })),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const config = await configManager.getFullConfig();
			const endStatus = beginStatus(ctx, "Docs Search");
			try {
				const sessionId = newSessionId();
				const result = await runDocsSearch(
					params.query,
					{
						provider: params.provider,
						libraryId: params.library_id,
						maxResults: params.max_results,
						maxOutputBytes: params.max_output_bytes,
					},
					signal,
				);
				sourcesCache.set(sessionId, result.sources);
				let output = result.output;
				if (result.sources.length > 0) {
					const visibleSources = limitSources(result.sources, clampNumber(params.max_results, 6, 1, 20));
					output += `\n\n---\n**信源 (${visibleSources.length}/${result.sources.length})** | session_id: \`${sessionId}\`\n`;
					for (const s of visibleSources) output += s.title ? `- [${s.title}](${s.url}) [${s.provider || "docs"}]\n` : `- ${s.url}\n`;
					if (result.sources.length > visibleSources.length) {
						output += `- ... 还有 ${result.sources.length - visibleSources.length} 个信源，使用 search_sources 分页获取\n`;
					}
				}
				const rendered = await truncateToolOutput(output, "docs-search", {
					maxBytes: clampNumber(params.max_output_bytes, 12000, 3000, 50 * 1024),
				});
				const { content, ...outputDetails } = rendered;
				return {
					content: [{ type: "text", text: content }],
					details: {
						session_id: sessionId,
						sources_count: result.sources.length,
						...capabilityDiagnostics(config, result.attempts, "docs_search"),
						...outputDetails,
					},
				};
			} finally {
				endStatus();
			}
		},
	});

	// =========================================================================
	// Tool: search_sources — 获取缓存信源
	// =========================================================================
	pi.registerTool({
		name: "search_sources",
		label: "Search Sources",
		description:
			"通过 session_id 分页获取之前 search 缓存的信源列表。\n" +
			"当对搜索结果感兴趣或需要更多参考链接时使用。",
		promptSnippet: "通过 session_id 获取搜索信源列表",
		promptGuidelines: [
			"Use search_sources with the session_id from search to retrieve source URLs page by page when you need more references.",
		],
		parameters: Type.Object({
			session_id: Type.String({ description: "search 返回的 session_id" }),
			limit: Type.Optional(
				Type.Number({ description: "本次返回信源数量（1-100），默认 20", minimum: 1, maximum: 100 }),
			),
			offset: Type.Optional(
				Type.Number({ description: "从第几个信源开始返回，默认 0", minimum: 0 }),
			),
			format: Type.Optional(
				StringEnum(["compact", "full"] as const, {
					description: "compact 只返回标题/URL/provider；full 包含描述。默认 compact。",
				}),
			),
		}),

		async execute(_toolCallId, params) {
			const sources = sourcesCache.get(params.session_id);
			if (!sources) {
				return {
					content: [
						{
							type: "text",
							text: `未找到 session_id: ${params.session_id} 的信源缓存（可能已过期）`,
						},
					],
					details: {
						session_id: params.session_id,
						offset: 0,
						limit: 0,
						returned_sources_count: 0,
						sources_count: 0,
					},
				};
			}

			const offset = clampNumber(params.offset, 0, 0, Math.max(0, sources.length));
			const limit = clampNumber(params.limit, 20, 1, 100);
			const page = sources.slice(offset, offset + limit);
			const format = params.format || "compact";
			const rangeStart = page.length > 0 ? offset + 1 : offset;
			const rangeEnd = offset + page.length;
			let output = `## 信源列表 (${rangeStart}-${rangeEnd}/${sources.length})\n\n`;
			if (page.length === 0) output += "没有更多信源。\n";
			for (const s of page) {
				if (s.title) {
					output += `- **[${s.title}](${s.url})**`;
				} else {
					output += `- ${s.url}`;
				}
				if (format === "full" && s.description) output += ` — ${s.description.slice(0, 200)}`;
				if (s.provider) output += ` [${s.provider}]`;
				output += "\n";
			}
			if (offset + page.length < sources.length) {
				output += `\n下一页: search_sources(session_id=\`${params.session_id}\`, offset=${offset + page.length}, limit=${limit})\n`;
			}

			return {
				content: [{ type: "text", text: output }],
				details: {
					session_id: params.session_id,
					offset,
					limit,
					returned_sources_count: page.length,
					sources_count: sources.length,
				},
			};
		},
	});

	// =========================================================================
	// Tool: web_fetch — 网页内容抓取（Tavily → Firecrawl → smart_direct → direct 自动降级）
	// =========================================================================
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"独立抓取一个明确的 HTTP/HTTPS URL，并返回受输出预算保护的页面/API 预览。\n" +
			"默认 format=markdown；markdown/text 优先使用 Tavily Extract，markdown/html/raw 可降级到 Firecrawl Scrape，再用 smart_direct（wreq-js TLS 指纹 + Defuddle 可读正文提取），最后使用 direct fetch。\n" +
			"可独立用于用户给定 URL，也可作为 search 后检查选中信源的后续工具；不执行 JavaScript，不处理登录会话，也不是批量下载器。",
		promptSnippet: "独立抓取指定 URL 预览；也可检查 search 选中信源",
		promptGuidelines: [
			"Use web_fetch directly when the user provides a concrete HTTP(S) URL and asks to read, inspect, summarize, verify, or debug that page/API response.",
			"Keep the existing search flow: when the URL is unknown, use search first, then web_fetch only for selected high-value source URLs that need inspection.",
			"Default to format=markdown for readable page previews. Use format=text for plain text, html for cleaned/source HTML inspection, json for API payloads or structured metadata, and raw only for bounded raw-body/rawHtml debugging.",
			"Use returned details.metadata for status, final URL, content type, content length, title, description, canonical URL, and binary/large-file decisions.",
			"Do not treat web_fetch as a browser, JavaScript renderer, login/session tool, bulk downloader, or anti-bot bypass; large/binary targets should be summarized by metadata instead of injected.",
			"Respect the context budget: fetch one URL at a time, avoid raw/html unless needed, and increase max_output_bytes only when the user explicitly needs more content.",
			"Use provider=smart_direct for HTML pages where normal direct fetch is noisy or blocked; it uses browser-grade TLS/HTTP fingerprinting plus Defuddle extraction but still does not execute JavaScript.",
			"If extraction is thin, truncated, blocked, or mismatched, report that limitation and switch back to search or a narrower URL instead of repeatedly fetching broad pages.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "要抓取的网页 URL（HTTP/HTTPS）" }),
			format: Type.Optional(
				StringEnum(WEB_FETCH_FORMAT_VALUES, {
					description: "输出格式。默认 markdown；html/raw/json 仅在需要源码、接口载荷或排错时使用。",
				}),
			),
			provider: Type.Optional(
				StringEnum(WEB_FETCH_PROVIDER_VALUES, {
					description: "抓取 provider。auto 默认链路：Tavily → Firecrawl → smart_direct → direct。",
				}),
			),
			max_output_bytes: Type.Optional(
				Type.Number({ description: "返回内容最大字节数，默认 12000；长输出会自动折叠并保存完整文件", minimum: 3000, maximum: 51200 }),
			),
			maxChars: Type.Optional(Type.Number({ description: "smart_direct 提取后最大字符数，默认 50000", minimum: 1000, maximum: 200000 })),
			timeout_ms: Type.Optional(Type.Number({ description: "smart_direct 请求超时毫秒，默认 15000", minimum: 1000, maximum: 120000 })),
			browser: Type.Optional(Type.String({ description: "smart_direct TLS 指纹浏览器，如 chrome_145 / firefox_147 / safari_26" })),
			os: Type.Optional(Type.String({ description: "smart_direct OS 指纹：windows / macos / linux / android / ios" })),
			headers: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "smart_direct 额外请求头" })),
			remove_images: Type.Optional(Type.Boolean({ description: "smart_direct/Defuddle 是否移除图片，默认 false" })),
			include_replies: Type.Optional(Type.Any({ description: "smart_direct/Defuddle 回复提取策略：extractors | true | false" })),
			proxy: Type.Optional(Type.String({ description: "smart_direct 代理 URL" })),
			verbose: Type.Optional(Type.Boolean({ description: "smart_direct 是否输出完整 metadata header" })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const config = await configManager.getFullConfig();
			const maxOutputBytes = clampNumber(params.max_output_bytes, 12000, 3000, 50 * 1024);
			const format = normalizeWebFetchFormat(params.format);
			const providerChoice = normalizeWebFetchProviderChoice(params.provider);
			const smartOptions = resolveSmartDirectOptions(params as Record<string, unknown>);
			let url: string;
			try {
				url = normalizeHttpUrl(params.url);
			} catch (e) {
				return {
					content: [{ type: "text", text: `URL 错误: ${e instanceof Error ? e.message : String(e)}` }],
					details: { url: params.url, format, error: "invalid_url" },
				};
			}
			const endStatus = beginStatus(ctx, formatSearchStatus(config.searchModel));
			onUpdate?.({ content: [{ type: "text", text: `📄 正在抓取网页 (${format}/${providerChoice})...` }], details: {} });

			try {
				const attempts: ProviderAttempt[] = [];
				const finish = async (result: WebFetchResult) => {
					const finished = await finishWebFetchResult(result, maxOutputBytes);
					return {
						...finished,
						details: {
							...finished.details,
							...capabilityDiagnostics(config, attempts, "web_fetch"),
						},
					};
				};

				const auto = providerChoice === "auto";
				const allowFallback = auto && config.fallbackMode === "auto";

				if ((auto || providerChoice === "tavily") && config.tavilyApiKey) {
					const result = await withOptionalProviderAttempt(
						attempts,
						"web_fetch",
						"tavily",
						() => tavilyExtract(url, format, signal),
					);
					if (result) return finish(result);
					if (!auto) return fetchFailure(url, format, providerChoice, config, attempts);
				}

				if ((allowFallback || providerChoice === "firecrawl") && config.firecrawlApiKey) {
					onUpdate?.({
						content: [{ type: "text", text: "📄 Tavily 不适用或失败，尝试 Firecrawl..." }],
						details: {},
					});
					const result = await withOptionalProviderAttempt(
						attempts,
						"web_fetch",
						"firecrawl",
						() => firecrawlScrape(url, format, signal),
					);
					if (result) return finish(result);
					if (!auto) return fetchFailure(url, format, providerChoice, config, attempts);
				}

				if ((allowFallback || providerChoice === "smart_direct") && smartDirectSupported(format)) {
					onUpdate?.({
						content: [{ type: "text", text: "📄 提取服务不适用或失败，尝试 smart_direct..." }],
						details: {},
					});
					const result = await withOptionalProviderAttempt(
						attempts,
						"web_fetch",
						"smart_direct",
						() => smartDirectFetch(url, format, smartOptions, signal),
					);
					if (result) return finish(result);
					if (!auto) return fetchFailure(url, format, providerChoice, config, attempts);
				}

				if (auto || providerChoice === "direct") {
					onUpdate?.({
						content: [{ type: "text", text: "📄 smart_direct 不适用或失败，尝试 direct fetch..." }],
						details: {},
					});
					const directResult = await withOptionalProviderAttempt(
						attempts,
						"web_fetch",
						"direct",
						() => directFetch(url, format, maxOutputBytes, signal),
					);
					if (directResult) return finish(directResult);
				}

				return {
					content: [
						{
							type: "text",
							text: "提取失败: Tavily/Firecrawl/smart_direct/direct fetch 均未能获取可注入的文本内容。可尝试用 search 搜索相关内容。",
						},
					],
					details: {
						url,
						format,
						error: attempts.length === 0 ? "provider_not_configured_or_unsupported" : "all_failed",
						...capabilityDiagnostics(config, attempts, "web_fetch"),
					},
				};
			} finally {
				endStatus();
			}
		},
	});

	// =========================================================================
	// Tool: web_map — 站点结构映射
	// =========================================================================
	pi.registerTool({
		name: "web_map",
		label: "Web Map",
		description:
			"通过 Tavily Map API 遍历网站结构，发现 URL 并生成站点地图。\n" +
			"从根 URL 开始图遍历，支持深度/广度控制和自然语言过滤。",
		promptSnippet: "遍历网站结构，发现 URL 生成站点地图",
		promptGuidelines: [
			"Use web_map to discover a website's structure and find specific pages.",
			"Start with low max_depth (1-2) for initial exploration.",
		],
		parameters: Type.Object({
			url: Type.String({
				description: "起始 URL（如 'https://docs.example.com'）",
			}),
			instructions: Type.Optional(
				Type.String({
					description: "自然语言过滤指令（如 'only documentation pages'）",
				}),
			),
			max_depth: Type.Optional(
				Type.Number({ description: "最大遍历深度（1-5），默认 1", minimum: 1, maximum: 5 }),
			),
			max_breadth: Type.Optional(
				Type.Number({ description: "每页最大跟踪链接数（1-500），默认 10", minimum: 1, maximum: 500 }),
			),
			limit: Type.Optional(
				Type.Number({ description: "总链接处理上限（1-500），默认 30", minimum: 1, maximum: 500 }),
			),
			timeout: Type.Optional(
				Type.Number({ description: "超时秒数（10-150），默认 150", minimum: 10, maximum: 150 }),
			),
			max_output_bytes: Type.Optional(
				Type.Number({ description: "返回内容最大字节数，默认 12000", minimum: 3000, maximum: 51200 }),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const config = await configManager.getFullConfig();
			const attempts: ProviderAttempt[] = [];
			const endStatus = beginStatus(ctx, formatSearchStatus(config.searchModel));
			try {
				try {
					const result = await withProviderAttempt(
						attempts,
						"site_map",
						"tavily",
						async () => {
							const mapped = await tavilyMap(
								params.url,
								{
									instructions: params.instructions,
									maxDepth: params.max_depth,
									maxBreadth: params.max_breadth,
									limit: params.limit ?? 30,
									timeout: params.timeout,
								},
								signal,
							);
							if (/^(配置错误|映射失败|映射错误):/.test(mapped)) throw new Error(mapped);
							return mapped;
						},
					);
					const output = await truncateToolOutput(result, "web-map", {
						maxBytes: clampNumber(params.max_output_bytes, 12000, 3000, 50 * 1024),
					});
					const { content, ...outputDetails } = output;
					return {
						content: [{ type: "text", text: content }],
						details: { url: params.url, ...capabilityDiagnostics(config, attempts, "site_map"), ...outputDetails },
					};
				} catch (e) {
					if (e instanceof Error && e.name === "AbortError") throw e;
					return {
						content: [{ type: "text", text: `映射失败: ${e instanceof Error ? e.message : String(e)}` }],
						details: {
							url: params.url,
							error: e instanceof Error ? e.message : String(e),
							...capabilityDiagnostics(config, attempts, "site_map"),
						},
					};
				}
			} finally {
				endStatus();
			}
		},
	});

	// =========================================================================
	// Tool: search_config — 配置管理
	// =========================================================================
	pi.registerTool<typeof searchConfigParameters, Record<string, unknown>>({
		name: "search_config",
		label: "Search Config",
		description:
			"查看或修改 Pi Search 的完整配置（OpenAI-compatible Search API/Tavily/Firecrawl API）。",
		promptSnippet: "查看或修改 Pi Search 配置",
		parameters: searchConfigParameters,

		async execute(_toolCallId, params) {
			const config = await configManager.getFullConfig();

			if (params.action === "show") {
				const lines = [
					"## Pi Search 配置\n",
					"| 配置项 | 值 |",
					"|--------|-----|",
					`| Search API URL | ${config.searchApiUrl || "❌ 未配置"} |`,
					`| Search API Key | ${config.searchApiKey ? configManager.maskKey(config.searchApiKey) : "❌ 未配置"} |`,
					`| 搜索模型 | ${config.searchModel || "❌ 未配置"} |`,
					`| 搜索模式 | ${formatSearchProfile(config.searchProfile)} |`,
					`| Fallback Mode | ${config.fallbackMode} |`,
					`| Minimum Profile | ${config.minimumProfile} |`,
					`| Tavily API URL | ${config.tavilyApiUrl} |`,
					`| Tavily API Key | ${config.tavilyApiKey ? configManager.maskKey(config.tavilyApiKey) : "❌ 未配置"} |`,
					`| Firecrawl API URL | ${config.firecrawlApiUrl} |`,
					`| Firecrawl API Key | ${config.firecrawlApiKey ? configManager.maskKey(config.firecrawlApiKey) : "❌ 未配置"} |`,
					`| Context7 Base URL | ${config.context7BaseUrl} |`,
					`| Context7 API Key | ${config.context7ApiKey ? configManager.maskKey(config.context7ApiKey) : "可选/未配置"} |`,
					`| Exa Base URL | ${config.exaBaseUrl} |`,
					`| Exa API Key | ${config.exaApiKey ? configManager.maskKey(config.exaApiKey) : "❌ 未配置"} |`,
					`| 配置文件 | ${configManager.getConfigPath()} |`,
					"\n## Capability Status\n",
					"| Capability | Required | Available | Providers |",
					"|------------|----------|-----------|-----------|",
					...capabilityStatus(config).map((status) => `| ${status.capability} | ${status.required ? "yes" : "no"} | ${status.available ? "✅" : "❌"} | ${status.providers.map((provider) => `${provider.provider}:${provider.configured ? "on" : "off"}`).join(", ")} |`),
				];

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { ...config },
				};
			}

			if (params.action === "test") {
				const results: string[] = ["## 连接测试\n"];
				const attempts: ProviderAttempt[] = [];

				if (config.searchApiUrl && config.searchApiKey) {
					try {
						const start = Date.now();
						const models = await withProviderAttempt(
							attempts,
							"main_search",
							"openai_compatible",
							() => getAvailableModelsCached(config.searchApiUrl, config.searchApiKey),
						);
						const elapsed = Date.now() - start;
						results.push(`✅ **Search API**: 连接成功 (${elapsed}ms)，${models.length} 个模型`);
						if (models.length > 0) {
							results.push(`   模型: ${models.slice(0, 10).join(", ")}${models.length > 10 ? "..." : ""}`);
						}
					} catch (e) {
						results.push(`❌ **Search API**: ${e instanceof Error ? e.message : String(e)}`);
					}
				} else {
					results.push("⏭️ **Search API**: 未配置");
				}

				try {
					const libraries = await withProviderAttempt(
						attempts,
						"docs_search",
						"context7",
						() => context7LibrarySearch("react", 1),
					);
					results.push(`✅ **Context7**: 连接成功，${libraries.length} 个库结果`);
				} catch (e) {
					results.push(`❌ **Context7**: ${e instanceof Error ? e.message : "连接失败"}`);
				}

				if (config.exaApiKey) {
					try {
						const exa = await withProviderAttempt(
							attempts,
							"docs_search",
							"exa",
							() => exaSearch("react docs", 1),
						);
						results.push(`✅ **Exa API**: 连接成功，${exa.length} 个结果`);
					} catch (e) {
						results.push(`❌ **Exa API**: ${e instanceof Error ? e.message : "连接失败"}`);
					}
				} else {
					results.push("⏭️ **Exa API**: 未配置");
				}

				if (config.tavilyApiKey) {
					try {
						const sources = await withProviderAttempt(
							attempts,
							"web_search",
							"tavily",
							() => tavilySearch("test", 1),
						);
						results.push(`✅ **Tavily API**: 连接成功，${sources.length} 个结果`);
					} catch (e) {
						results.push(`❌ **Tavily API**: ${e instanceof Error ? e.message : "连接失败"}`);
					}
				} else {
					results.push("⏭️ **Tavily API**: 未配置");
				}

				if (config.firecrawlApiKey) {
					try {
						const result = await withOptionalProviderAttempt(
							attempts,
							"web_fetch",
							"firecrawl",
							() => firecrawlScrape("https://example.com", "markdown"),
						);
						results.push(result ? "✅ **Firecrawl API**: 连接成功" : "❌ **Firecrawl API**: 未返回内容");
					} catch (e) {
						results.push(`❌ **Firecrawl API**: ${e instanceof Error ? e.message : "连接失败"}`);
					}
				} else {
					results.push("⏭️ **Firecrawl API**: 未配置");
				}

				const statuses = capabilityStatus(config);
				results.push("\n## Capability Status");
				for (const status of statuses) {
					results.push(`- ${status.available ? "✅" : "❌"} ${status.capability}${status.required ? " (required)" : ""}: ${status.providers.map((provider) => `${provider.provider}:${provider.configured ? "on" : "off"}`).join(", ")}`);
				}
				results.push(`\nMinimum profile (${config.minimumProfile}): ${minimumProfileSatisfied(statuses, config.minimumProfile) ? "✅ satisfied" : "❌ missing required capability"}`);
				results.push(`Fallback mode: ${config.fallbackMode}`);
				results.push(...providerAttemptsMarkdown(attempts));

				return {
					content: [{ type: "text", text: results.join("\n") }],
					details: { tested: true, ...capabilityDiagnostics(config, attempts) },
				};
			}

			if (params.action === "set") {
				if (!params.key || !params.value) {
					throw new Error("action=set 时 key 和 value 为必填项");
				}

				const displayValue = params.key.toLowerCase().includes("key")
					? configManager.maskKey(params.value)
					: params.value;

				switch (params.key) {
					case "searchApiUrl": {
						const file = await configManager.loadFile();
						await configManager.setSearchApi(
							params.value,
							file.apiKey || config.searchApiKey,
						);
						break;
					}
					case "searchApiKey": {
						const file = await configManager.loadFile();
						await configManager.setSearchApi(
							file.apiUrl || config.searchApiUrl,
							params.value,
						);
						break;
					}
					case "model":
						await configManager.setModel(params.value);
						break;
					case "searchProfile": {
						const profile = parseSearchProfile(params.value);
						if (!profile) {
							throw new Error(`无效搜索模式: ${params.value}`);
						}
						await configManager.setSearchProfile(profile);
						break;
					}
					case "fallbackMode": {
						if (!(["auto", "off"] as const).includes(params.value as FallbackMode)) {
							throw new Error("fallbackMode 只能是 auto 或 off");
						}
						await configManager.setSearchRuntime("fallbackMode", params.value);
						break;
					}
					case "minimumProfile": {
						if (!(["standard", "off"] as const).includes(params.value as MinimumProfile)) {
							throw new Error("minimumProfile 只能是 standard 或 off");
						}
						await configManager.setSearchRuntime("minimumProfile", params.value);
						break;
					}
					case "tavilyApiKey":
						await configManager.setTavily(params.value);
						break;
					case "tavilyApiUrl":
						await configManager.setTavily(config.tavilyApiKey, params.value);
						break;
					case "firecrawlApiKey":
						await configManager.setFirecrawl(params.value);
						break;
					case "firecrawlApiUrl":
						await configManager.setFirecrawl(
							config.firecrawlApiKey,
							params.value,
						);
						break;
					case "context7ApiKey":
						await configManager.setContext7(params.value);
						break;
					case "context7BaseUrl":
						await configManager.setContext7(config.context7ApiKey, params.value);
						break;
					case "exaApiKey":
						await configManager.setExa(params.value);
						break;
					case "exaBaseUrl":
						await configManager.setExa(config.exaApiKey, params.value);
						break;
				}

				return {
					content: [
						{ type: "text", text: `✅ 已更新 ${params.key} = ${displayValue}` },
					],
					details: { key: params.key, updated: true },
				};
			}

			throw new Error(`未知 action: ${params.action}`);
		},
	});

	// =========================================================================
	// Tool: search_planning — 搜索规划（6 阶段）
	// =========================================================================
	pi.registerTool({
		name: "search_planning",
		label: "Search Planning",
		description:
			"结构化搜索规划工具。在执行复杂搜索前先生成可执行的搜索计划。\n" +
			"流程: plan_intent → plan_complexity → plan_sub_query(×N) → plan_search_term(×N) → plan_tool_mapping(×N) → plan_execution\n" +
			"复杂度 Level 1 = 阶段 1-3; Level 2 = 阶段 1-5; Level 3 = 全部 6 阶段。",
		promptSnippet: "结构化搜索规划（分阶段、多轮）",
		promptGuidelines: [
			"Use search_planning before executing complex, multi-faceted searches to create a structured plan.",
		],
		parameters: Type.Object({
			phase: StringEnum([
				"intent_analysis",
				"complexity_assessment",
				"query_decomposition",
				"search_strategy",
				"tool_selection",
				"execution_order",
			] as const),
			thought: Type.String({ description: "本阶段的推理过程" }),
			session_id: Type.Optional(
				Type.String({ description: "留空创建新会话，或传入已有 ID" }),
			),
			is_revision: Type.Optional(
				Type.Boolean({ description: "是否覆盖已有阶段" }),
			),
			confidence: Type.Optional(Type.Number({ description: "置信度 0.0-1.0" })),
			phase_data: Type.String({ description: "阶段数据，JSON 字符串格式" }),
		}),

		async execute(_toolCallId, params) {
			let phaseData: unknown;
			try {
				phaseData = JSON.parse(params.phase_data);
			} catch {
				phaseData = params.phase_data;
			}

			const result = planningEngine.processPhase({
				phase: params.phase,
				thought: params.thought,
				sessionId: params.session_id,
				isRevision: params.is_revision,
				confidence: params.confidence,
				phaseData,
			});

			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});

	// =========================================================================
	// Strongly typed planning tools — wrappers around search_planning.
	// =========================================================================
	pi.registerTool({
		name: "plan_intent",
		label: "Plan Intent",
		description:
			"Phase 1 of search planning: analyze user intent. Call this first to create a planning session.",
		promptSnippet: "Phase 1 search planning: analyze intent and create a session",
		promptGuidelines: [
			"Use plan_intent first when planning complex searches; pass its session_id to later planning tools.",
		],
		parameters: Type.Object({
			thought: Type.String({ description: "Reasoning for this phase" }),
			core_question: Type.String({ description: "Distilled core question in one sentence" }),
			query_type: StringEnum(["factual", "comparative", "exploratory", "analytical"] as const),
			time_sensitivity: StringEnum(["realtime", "recent", "historical", "irrelevant"] as const),
			session_id: Type.Optional(Type.String({ description: "Empty for new session, or existing ID to revise" })),
			confidence: Type.Optional(Type.Number({ description: "Confidence 0.0-1.0", minimum: 0, maximum: 1 })),
			domain: Type.Optional(Type.String({ description: "Specific domain if identifiable" })),
			premise_valid: Type.Optional(Type.Boolean({ description: "False if the question contains a flawed assumption" })),
			ambiguities: Type.Optional(Type.Array(Type.String(), { description: "Unresolved ambiguities" })),
			unverified_terms: Type.Optional(Type.Array(Type.String(), { description: "External terms/taxonomies to verify" })),
			is_revision: Type.Optional(Type.Boolean({ description: "True to overwrite existing intent" })),
		}),
		async execute(_toolCallId, params) {
			const phaseData: Record<string, unknown> = {
				core_question: params.core_question,
				query_type: params.query_type,
				time_sensitivity: params.time_sensitivity,
			};
			if (params.domain) phaseData.domain = params.domain;
			if (params.premise_valid !== undefined) phaseData.premise_valid = params.premise_valid;
			if (params.ambiguities) phaseData.ambiguities = params.ambiguities;
			if (params.unverified_terms) phaseData.unverified_terms = params.unverified_terms;
			const result = planningEngine.processPhase({
				phase: "intent_analysis",
				thought: params.thought,
				sessionId: params.session_id,
				isRevision: params.is_revision,
				confidence: params.confidence,
				phaseData,
			});
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});

	pi.registerTool({
		name: "plan_complexity",
		label: "Plan Complexity",
		description: "Phase 2: assess search complexity from 1 to 3 and determine required phases.",
		promptSnippet: "Phase 2 search planning: assess complexity",
		parameters: Type.Object({
			session_id: Type.String({ description: "Session ID from plan_intent" }),
			thought: Type.String({ description: "Reasoning for complexity assessment" }),
			level: Type.Number({ description: "Complexity 1-3", minimum: 1, maximum: 3 }),
			estimated_sub_queries: Type.Number({ description: "Expected number of sub-queries", minimum: 1, maximum: 20 }),
			estimated_tool_calls: Type.Number({ description: "Expected total tool calls", minimum: 1, maximum: 50 }),
			justification: Type.String({ description: "Why this complexity level" }),
			confidence: Type.Optional(Type.Number({ description: "Confidence 0.0-1.0", minimum: 0, maximum: 1 })),
			is_revision: Type.Optional(Type.Boolean({ description: "True to overwrite" })),
		}),
		async execute(_toolCallId, params) {
			if (!planningEngine.getSession(params.session_id)) {
				const error = { error: `Session '${params.session_id}' not found. Call plan_intent first.` };
				return { content: [{ type: "text", text: JSON.stringify(error, null, 2) }], details: error };
			}
			const result = planningEngine.processPhase({
				phase: "complexity_assessment",
				thought: params.thought,
				sessionId: params.session_id,
				isRevision: params.is_revision,
				confidence: params.confidence,
				phaseData: {
					level: params.level,
					estimated_sub_queries: params.estimated_sub_queries,
					estimated_tool_calls: params.estimated_tool_calls,
					justification: params.justification,
				},
			});
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});

	pi.registerTool({
		name: "plan_sub_query",
		label: "Plan Sub-query",
		description: "Phase 3: add one sub-query. Call once per sub-query; data accumulates.",
		promptSnippet: "Phase 3 search planning: add a sub-query",
		parameters: Type.Object({
			session_id: Type.String({ description: "Session ID from plan_intent" }),
			thought: Type.String({ description: "Reasoning for this sub-query" }),
			id: Type.String({ description: "Unique ID, e.g. sq1" }),
			goal: Type.String({ description: "Sub-query goal" }),
			expected_output: Type.String({ description: "What success looks like" }),
			boundary: Type.String({ description: "What this excludes; should be mutually exclusive with siblings" }),
			confidence: Type.Optional(Type.Number({ description: "Confidence 0.0-1.0", minimum: 0, maximum: 1 })),
			depends_on: Type.Optional(Type.Array(Type.String(), { description: "Prerequisite sub-query IDs" })),
			tool_hint: Type.Optional(StringEnum(["search", "docs_search", "web_fetch", "web_map"] as const)),
			is_revision: Type.Optional(Type.Boolean({ description: "True to replace all sub-queries" })),
		}),
		async execute(_toolCallId, params) {
			if (!planningEngine.getSession(params.session_id)) {
				const error = { error: `Session '${params.session_id}' not found. Call plan_intent first.` };
				return { content: [{ type: "text", text: JSON.stringify(error, null, 2) }], details: error };
			}
			const phaseData: Record<string, unknown> = {
				id: params.id,
				goal: params.goal,
				expected_output: params.expected_output,
				boundary: params.boundary,
			};
			if (params.depends_on) phaseData.depends_on = params.depends_on;
			if (params.tool_hint) phaseData.tool_hint = params.tool_hint;
			const result = planningEngine.processPhase({
				phase: "query_decomposition",
				thought: params.thought,
				sessionId: params.session_id,
				isRevision: params.is_revision,
				confidence: params.confidence,
				phaseData,
			});
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});

	pi.registerTool({
		name: "plan_search_term",
		label: "Plan Search Term",
		description: "Phase 4: add one search term. Call once per term; data accumulates.",
		promptSnippet: "Phase 4 search planning: add a search term",
		parameters: Type.Object({
			session_id: Type.String({ description: "Session ID from plan_intent" }),
			thought: Type.String({ description: "Reasoning for this search term" }),
			term: Type.String({ description: "Search query, ideally <= 8 words" }),
			purpose: Type.String({ description: "Sub-query ID this term serves" }),
			round: Type.Number({ description: "Execution round", minimum: 1 }),
			confidence: Type.Optional(Type.Number({ description: "Confidence 0.0-1.0", minimum: 0, maximum: 1 })),
			approach: Type.Optional(StringEnum(["broad_first", "narrow_first", "targeted"] as const)),
			fallback_plan: Type.Optional(Type.String({ description: "Fallback if primary searches fail" })),
			is_revision: Type.Optional(Type.Boolean({ description: "True to replace all search terms" })),
		}),
		async execute(_toolCallId, params) {
			if (!planningEngine.getSession(params.session_id)) {
				const error = { error: `Session '${params.session_id}' not found. Call plan_intent first.` };
				return { content: [{ type: "text", text: JSON.stringify(error, null, 2) }], details: error };
			}
			const phaseData: Record<string, unknown> = {
				search_terms: [{ term: params.term, purpose: params.purpose, round: params.round }],
			};
			if (params.approach) phaseData.approach = params.approach;
			if (params.fallback_plan) phaseData.fallback_plan = params.fallback_plan;
			const result = planningEngine.processPhase({
				phase: "search_strategy",
				thought: params.thought,
				sessionId: params.session_id,
				isRevision: params.is_revision,
				confidence: params.confidence,
				phaseData,
			});
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});

	pi.registerTool({
		name: "plan_tool_mapping",
		label: "Plan Tool Mapping",
		description: "Phase 5: map a sub-query to a tool. Call once per mapping; data accumulates.",
		promptSnippet: "Phase 5 search planning: map sub-query to tool",
		parameters: Type.Object({
			session_id: Type.String({ description: "Session ID from plan_intent" }),
			thought: Type.String({ description: "Reasoning for this mapping" }),
			sub_query_id: Type.String({ description: "Sub-query ID to map" }),
			tool: StringEnum(["search", "docs_search", "web_fetch", "web_map"] as const),
			reason: Type.String({ description: "Why this tool for this sub-query" }),
			confidence: Type.Optional(Type.Number({ description: "Confidence 0.0-1.0", minimum: 0, maximum: 1 })),
			params_json: Type.Optional(Type.String({ description: "Optional JSON string for tool-specific params" })),
			is_revision: Type.Optional(Type.Boolean({ description: "True to replace all mappings" })),
		}),
		async execute(_toolCallId, params) {
			if (!planningEngine.getSession(params.session_id)) {
				const error = { error: `Session '${params.session_id}' not found. Call plan_intent first.` };
				return { content: [{ type: "text", text: JSON.stringify(error, null, 2) }], details: error };
			}
			const phaseData: Record<string, unknown> = {
				sub_query_id: params.sub_query_id,
				tool: params.tool,
				reason: params.reason,
			};
			if (params.params_json) {
				try {
					phaseData.params = JSON.parse(params.params_json);
				} catch {
					phaseData.params_raw = params.params_json;
				}
			}
			const result = planningEngine.processPhase({
				phase: "tool_selection",
				thought: params.thought,
				sessionId: params.session_id,
				isRevision: params.is_revision,
				confidence: params.confidence,
				phaseData,
			});
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});

	pi.registerTool({
		name: "plan_execution",
		label: "Plan Execution",
		description: "Phase 6: define execution order for sub-queries.",
		promptSnippet: "Phase 6 search planning: define execution order",
		parameters: Type.Object({
			session_id: Type.String({ description: "Session ID from plan_intent" }),
			thought: Type.String({ description: "Reasoning for execution order" }),
			parallel: Type.Optional(Type.Array(Type.Array(Type.String()), { description: "Groups of sub-query IDs runnable in parallel" })),
			sequential: Type.Optional(Type.Array(Type.String(), { description: "Sub-query IDs that must run in order" })),
			estimated_rounds: Type.Number({ description: "Estimated execution rounds", minimum: 1 }),
			confidence: Type.Optional(Type.Number({ description: "Confidence 0.0-1.0", minimum: 0, maximum: 1 })),
			is_revision: Type.Optional(Type.Boolean({ description: "True to overwrite" })),
		}),
		async execute(_toolCallId, params) {
			if (!planningEngine.getSession(params.session_id)) {
				const error = { error: `Session '${params.session_id}' not found. Call plan_intent first.` };
				return { content: [{ type: "text", text: JSON.stringify(error, null, 2) }], details: error };
			}
			const result = planningEngine.processPhase({
				phase: "execution_order",
				thought: params.thought,
				sessionId: params.session_id,
				isRevision: params.is_revision,
				confidence: params.confidence,
				phaseData: {
					parallel: params.parallel || [],
					sequential: params.sequential || [],
					estimated_rounds: params.estimated_rounds,
				},
			});
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});

	// =========================================================================
	// Command: /search
	// =========================================================================
	pi.registerCommand("search", {
		description: "使用搜索模型搜索网络（/search <query>）",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("用法: /search <搜索内容>", "warning");
				return;
			}

			const config = await configManager.getFullConfig();
			const endStatus = beginStatus(ctx, formatSearchStatus(config.searchModel));

			try {
				const controls = resolveSearchControls({ mode: "compact" }, config.searchProfile);
				const raw = await searchWithModel(args.trim(), "", undefined, "", controls, config.searchProfile);
				const { answer, sources } = splitAnswerAndSources(raw);
				const limitedAnswer = limitText(answer, controls.maxAnswerChars);

				let output = limitedAnswer.text;
				if (limitedAnswer.truncated) {
					output += `\n\n[Answer truncated to ${controls.maxAnswerChars} characters.]`;
				}
				if (sources.length > 0) {
					const sessionId = newSessionId();
					sourcesCache.set(sessionId, sources);
					const visibleSources = sources.slice(0, controls.maxSources);
					output += `\n\n---\n**信源 (${visibleSources.length}/${sources.length})** | session_id: \`${sessionId}\`\n`;
					for (const s of visibleSources) {
						output += s.title ? `- [${s.title}](${s.url})\n` : `- ${s.url}\n`;
					}
					if (sources.length > visibleSources.length) {
						output += `- ... 还有 ${sources.length - visibleSources.length} 个信源，使用 search_sources 分页获取\n`;
					}
				}
				if (!output.trim()) output = "未返回可显示内容。请尝试 normal/deep 模式或缩小查询。";

				const rendered = await truncateToolOutput(output, "search-command", { maxBytes: controls.maxOutputBytes });
				pi.sendMessage(
					{
						customType: "search",
						content: rendered.content,
						display: true,
						details: { sources_count: sources.length, profile: config.searchProfile },
					},
					{ triggerTurn: true },
				);
			} catch (e) {
				ctx.ui.notify(
					`搜索失败: ${e instanceof Error ? e.message : String(e)}`,
					"error",
				);
			} finally {
				endStatus();
			}
		},
	});

	// =========================================================================
	// Command: /search-config
	// =========================================================================
	pi.registerCommand("search-config", {
		description: "配置 Pi Search（Search API / Tavily / Firecrawl API）",
		handler: async (_args, ctx) => {
			const config = await configManager.getFullConfig();
			const choice = await ctx.ui.select("Pi Search 配置:", [
				"查看当前配置",
				"设置 Search API",
				"设置 Context7 API",
				"设置 Exa API",
				"设置 Tavily API",
				"设置 Firecrawl API",
				"切换模型",
				`切换搜索模式 (${SEARCH_PROFILE_DEFS[config.searchProfile].label})`,
				`切换 Fallback Mode (${config.fallbackMode})`,
				`切换 Minimum Profile (${config.minimumProfile})`,
				"测试所有连接",
			]);

			if (!choice) return;

			if (choice.startsWith("切换搜索模式")) {
				const config = await configManager.getFullConfig();
				const selected = await ctx.ui.select(
					"选择默认搜索模式:",
					searchProfileMenuItems(config.searchProfile),
				);
				if (!selected) return;
				const profile = searchProfileFromMenuItem(selected);
				if (!profile) return;
				await configManager.setSearchProfile(profile);
				ctx.ui.notify(`✅ 搜索模式已切换: ${formatSearchProfile(profile)}`, "info");
				return;
			}

			if (choice.startsWith("切换 Fallback Mode")) {
				const selected = await ctx.ui.select("Fallback Mode:", ["auto", "off"]);
				if (!selected) return;
				await configManager.setSearchRuntime("fallbackMode", selected);
				ctx.ui.notify(`✅ Fallback Mode 已切换: ${selected}`, "info");
				return;
			}

			if (choice.startsWith("切换 Minimum Profile")) {
				const selected = await ctx.ui.select("Minimum Profile:", ["standard", "off"]);
				if (!selected) return;
				await configManager.setSearchRuntime("minimumProfile", selected);
				ctx.ui.notify(`✅ Minimum Profile 已切换: ${selected}`, "info");
				return;
			}

			switch (choice) {
				case "查看当前配置": {
					const config = await configManager.getFullConfig();
					const lines = [
						`Search API: ${config.searchApiUrl || "未配置"} | ${config.searchApiKey ? configManager.maskKey(config.searchApiKey) : "未配置"}`,
						`模型: ${config.searchModel}`,
						`搜索模式: ${formatSearchProfile(config.searchProfile)}`,
						`Fallback Mode: ${config.fallbackMode}`,
						`Minimum Profile: ${config.minimumProfile}`,
						`Context7: ${config.context7BaseUrl} | ${config.context7ApiKey ? configManager.maskKey(config.context7ApiKey) : "API Key 可选/未配置"}`,
						`Exa: ${config.exaApiKey ? configManager.maskKey(config.exaApiKey) : "未配置"}`,
						`Tavily: ${config.tavilyApiKey ? configManager.maskKey(config.tavilyApiKey) : "未配置"}`,
						`Firecrawl: ${config.firecrawlApiKey ? configManager.maskKey(config.firecrawlApiKey) : "未配置"}`,
					];
					ctx.ui.notify(lines.join("\n"), "info");
					break;
				}

				case "设置 Search API": {
					const url = await ctx.ui.input(
						"Search API URL:",
						DEFAULT_SEARCH_API_URL,
					);
					if (!url) return;
					const key = await ctx.ui.input("Search API Key:", "");
					if (!key) return;
					await configManager.setSearchApi(url, key);
					ctx.ui.notify(`✅ Search API 已配置`, "info");
					break;
				}

				case "设置 Context7 API": {
					const url = await ctx.ui.input("Context7 Base URL:", config.context7BaseUrl);
					if (!url) return;
					const key = await ctx.ui.input("Context7 API Key（可留空）:", "");
					await configManager.setContext7(key || "", url);
					ctx.ui.notify(`✅ Context7 已配置`, "info");
					break;
				}

				case "设置 Exa API": {
					const key = await ctx.ui.input("Exa API Key:", "");
					if (!key) return;
					const url = await ctx.ui.input("Exa Base URL:", config.exaBaseUrl);
					await configManager.setExa(key, url || config.exaBaseUrl);
					ctx.ui.notify(`✅ Exa API 已配置`, "info");
					break;
				}

				case "设置 Tavily API": {
					const key = await ctx.ui.input("Tavily API Key:", "");
					if (!key) return;
					await configManager.setTavily(key);
					ctx.ui.notify(`✅ Tavily API 已配置`, "info");
					break;
				}

				case "设置 Firecrawl API": {
					const key = await ctx.ui.input("Firecrawl API Key:", "");
					if (!key) return;
					await configManager.setFirecrawl(key);
					ctx.ui.notify(`✅ Firecrawl API 已配置`, "info");
					break;
				}

				case "切换模型": {
					const config = await configManager.getFullConfig();
					ctx.ui.notify("正在获取可用模型...", "info");
					const models = await getAvailableModelsCached(
						config.searchApiUrl,
						config.searchApiKey,
					);

					if (models.length > 0) {
						const choice = await ctx.ui.select(
							`当前: ${config.searchModel}`,
							models,
						);
						if (choice) {
							await configManager.setModel(choice);
							ctx.ui.notify(`✅ 模型已切换: ${choice}`, "info");
						}
					} else {
						const model = await ctx.ui.input("输入模型 ID:", config.searchModel);
						if (model) {
							await configManager.setModel(model);
							ctx.ui.notify(`✅ 模型已切换: ${model}`, "info");
						}
					}
					break;
				}

				case "测试所有连接": {
					ctx.ui.notify("正在测试连接...", "info");
					const results: string[] = [];
					const config = await configManager.getFullConfig();
					const attempts: ProviderAttempt[] = [];

					if (config.searchApiUrl && config.searchApiKey) {
						try {
							const start = Date.now();
							const models = await withProviderAttempt(
								attempts,
								"main_search",
								"openai_compatible",
								() => getAvailableModelsCached(config.searchApiUrl, config.searchApiKey),
							);
							const elapsed = Date.now() - start;
							results.push(`✅ Search API: ${elapsed}ms, ${models.length} 模型`);
						} catch {
							results.push("❌ Search API: 连接失败");
						}
					} else {
						results.push("⏭️ Search API: 未配置");
					}

					try {
						const libraries = await withProviderAttempt(
							attempts,
							"docs_search",
							"context7",
							() => context7LibrarySearch("react", 1),
						);
						results.push(`✅ Context7: ${libraries.length} 库结果`);
					} catch {
						results.push("❌ Context7: 连接失败");
					}

					if (config.exaApiKey) {
						try {
							const exa = await withProviderAttempt(
								attempts,
								"docs_search",
								"exa",
								() => exaSearch("react docs", 1),
							);
							results.push(`✅ Exa: ${exa.length} 结果`);
						} catch {
							results.push("❌ Exa: 连接失败");
						}
					} else {
						results.push("⏭️ Exa: 未配置");
					}

					results.push(config.tavilyApiKey ? "✅ Tavily: 已配置" : "⏭️ Tavily: 未配置");
					results.push(config.firecrawlApiKey ? "✅ Firecrawl: 已配置" : "⏭️ Firecrawl: 未配置");
					results.push(`Fallback: ${config.fallbackMode}`);
					results.push(`Minimum Profile: ${minimumProfileSatisfied(capabilityStatus(config), config.minimumProfile) ? "✅" : "❌"} ${config.minimumProfile}`);
					results.push(...providerAttemptsMarkdown(attempts));

					ctx.ui.notify(results.join("\n"), "info");
					break;
				}
			}
		},
	});

	// =========================================================================
	// Command: /search-model
	// =========================================================================
	pi.registerCommand("search-model", {
		description: "快速切换搜索模型（/search-model [model-id]）",
		handler: async (args, ctx) => {
			if (args.trim()) {
				await configManager.setModel(args.trim());
				ctx.ui.notify(`✅ 模型已切换: ${args.trim()}`, "info");
				return;
			}

			const config = await configManager.getFullConfig();
			ctx.ui.notify("正在获取可用模型...", "info");
			const models = await getAvailableModelsCached(
				config.searchApiUrl,
				config.searchApiKey,
			);

			if (models.length > 0) {
				const choice = await ctx.ui.select(`当前: ${config.searchModel}`, models);
				if (choice) {
					await configManager.setModel(choice);
					ctx.ui.notify(`✅ 模型已切换: ${choice}`, "info");
				}
			} else {
				const model = await ctx.ui.input("输入模型 ID:", config.searchModel);
				if (model) {
					await configManager.setModel(model);
					ctx.ui.notify(`✅ 模型已切换: ${model}`, "info");
				}
			}
		},
	});

	// =========================================================================
	// Command: /pi-ext-docs
	// =========================================================================
	pi.registerCommand("pi-ext-docs", {
		description: "搜索 pi Extension 开发文档（/pi-ext-docs [topic]）",
		handler: async (args, ctx) => {
			const topic =
				args.trim() || "pi Extension API registerTool registerCommand";
			const config = await configManager.getFullConfig();
			const endStatus = beginStatus(ctx, formatSearchStatus(config.searchModel));

			try {
				const profile: SearchProfile = "coding_docs";
				const controls = resolveSearchControls({ mode: "compact", max_sources: 8 }, profile);
				const raw = await searchWithModel(
					`site:github.com earendil-works pi coding agent extensions ${topic}`,
					"",
					undefined,
					"",
					controls,
					profile,
				);
				const { answer, sources } = splitAnswerAndSources(raw);
				const limitedAnswer = limitText(answer, controls.maxAnswerChars);

				let output = `## pi Extension 文档搜索: ${topic}\n\n${limitedAnswer.text}`;
				if (limitedAnswer.truncated) {
					output += `\n\n[Answer truncated to ${controls.maxAnswerChars} characters.]`;
				}
				if (sources.length > 0) {
					const visibleSources = sources.slice(0, controls.maxSources);
					output += `\n\n### 相关链接 (${visibleSources.length}/${sources.length})\n`;
					for (const s of visibleSources) {
						output += s.title ? `- [${s.title}](${s.url})\n` : `- ${s.url}\n`;
					}
				}
				if (!output.trim()) output = "未返回可显示内容。请尝试缩小查询。";

				const rendered = await truncateToolOutput(output, "pi-ext-docs", { maxBytes: controls.maxOutputBytes });
				pi.sendMessage(
					{
						customType: "search",
						content: rendered.content,
						display: true,
						details: { sources_count: sources.length, profile },
					},
					{ triggerTurn: true },
				);
			} catch (e) {
				ctx.ui.notify(
					`搜索失败: ${e instanceof Error ? e.message : String(e)}`,
					"error",
				);
			} finally {
				endStatus();
			}
		},
	});

	// =========================================================================
	// Message Renderer
	// =========================================================================
	pi.registerMessageRenderer("search", (message, _options, theme) => {
		let text = theme.fg("accent", "🔍 Pi Search\n\n");
		text += message.content;
		return new Text(text, 0, 0);
	});

	// =========================================================================
	// Status bar stays hidden while idle; tools/commands show it only during work.
	// =========================================================================
	pi.on("session_start", async (_event, ctx) => {
		activeStatuses.length = 0;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
