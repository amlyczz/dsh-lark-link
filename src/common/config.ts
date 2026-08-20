// Bridge configuration: deep-merged defaults + runtime hot-reload overrides.
// Credentials (appId/appSecret) live in ctx.credentials, NOT here.
// Harness-agnostic module (no DSH / Feishu SDK imports).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type GroupPolicy = "open" | "mention" | "keywords" | "reply";

export interface FeishuConfig {
	/** Ref key into ctx.credentials for the app secret (never the secret itself).
	 * Must match credentialRef() pattern ^[A-Za-z_][A-Za-z0-9_]*$ (no dots). */
	credentialRef: string;
	/** Group trigger policy. */
	groupPolicy: GroupPolicy;
	/** Keyword triggers when groupPolicy = "keywords". */
	groupKeywords: string[];
	/** Also trigger when the bot is replied to (groupPolicy reply/mention). */
	alsoOnReply: boolean;
	/** Streaming: CardKit schema 2.0. Default OFF (省流量 — pi 31dc3c9:
	 * 每轮输出直发完整回复；需要流式再热改开启). */
	streaming: {
		enabled: boolean;
		printFrequencyMs: number;
		printStep: number;
	};
	/** Reaction receipts: random on inbound (pool excludes DONE), ✅ on completion. */
	reactions: {
		enabled: boolean;
		/** Default random pool — only Feishu-valid emoji types. */
		pool: string[];
		/** Completion marker (never in the random pool). */
		done: string;
	};
	/** Inbound media (downloaded Feishu images/files).
	 * Transient turn artifacts: default root is the OS temp dir with
	 * age-based sweeping — see attachments.dir / retentionHours. */
	attachments: {
		/** Root override for inbound media. Empty = OS temp dir
		 * (recommended: the OS may clear it at any time, the sweeper bounds
		 * growth). Applied at startup — changing it needs a reload. */
		dir: string;
		/** Hours an inbound image/file survives on disk. 0 = keep forever
		 * (pin attachments.dir to a durable location first). Hot-reloadable. */
		retentionHours: number;
	};
	/** Outbox tuning. */
	outbox: {
		/** Max attempts before an envelope becomes fatal. */
		maxAttempts: number;
		/** Bounded backoff ceiling, ms. */
		backoffMaxMs: number;
		/** Terminal-state retention, days. */
		retainDays: number;
		/** Hard cap of pending envelopes (spill protection). */
		pendingCap: number;
		/** Payloads above this many bytes spill to a blob file. */
		blobThreshold: number;
	};
	/** Connection supervision. */
	supervisor: {
		probeIntervalMs: number;
		probeTimeoutMs: number;
		/** Consecutive probe failures before degrade. */
		probeFailThreshold: number;
		/** Max reconnect attempts before quarantine. */
		maxReconnectAttempts: number;
		/** Quiet threshold: probe healthy => never rebuild idle connections. */
		idleKeepaliveMs: number;
	};
	/** Quota circuit breaker: window/limit of connect attempts. */
	quota: {
		windowMinutes: number;
		limit: number;
	};
	/** Deny list: exact command prefixes rejected outright (no prompt, no card). */
	denyList: string[];
	/** Session retention: idle TTL before agent dispose (memory). */
	sessionIdleTtlMs: number;
	/** Max concurrently hosted sessions. */
	maxSessions: number;
	/** Owner allowlist (optional): restrict inbound to these open_ids. Empty = all. */
	allowlist: string[];
	/** Bridge agent workspace root (cwd for created sessions). Empty = process.cwd(). */
	workspaceRoot: string;
	/**
	 * Agent preset for bridge sessions. Any preset id the deployment supplies —
	 * the shipped `standard | code | minimal | cordis`, OR a locally authored
	 * (user) preset id created in the DSH GUI — is valid. `/mode` renders the
	 * live roster (shipped + custom); `/lark-config agentPreset=<id>` accepts
	 * any id verbatim.
	 */
	agentPreset: string;
	/** Default DSH permission preset (read-only | workspace-write | danger-full-access). */
	permissionMode: string;
}

export const DEFAULT_CONFIG: FeishuConfig = {
	credentialRef: "LARK_LINK_APP",
	// 群聊免 @（对齐 pi-feishu-link：setup 已申请群聊全量权限）——
	// 群聊里任何消息都触发，不必 @ 机器人。
	groupPolicy: "open",
	groupKeywords: ["lark", "小斯"],
	alsoOnReply: true,
	streaming: {
		// Default OFF (省流量): 每轮输出直发完整回复，流式卡作为可选增强
		// (pi 31dc3c9 用户决策)。/lark-config streaming.enabled=true 热改开启。
		enabled: false,
		printFrequencyMs: 120,
		printStep: 3,
	},
	reactions: {
		enabled: true,
		// Only Feishu-valid emoji types (FIRE/ROCKET/SUN/WHITE_CHECK_MARK are
		// invalid → addReaction 231001; Fire is valid, FIRE is not).
		pool: ["THUMBSUP", "OK", "HEART", "LAUGH", "SMILE", "WOW", "CLAP", "Fire"],
		done: "DONE",
	},
	attachments: {
		dir: "",
		// 7 days: long enough for multi-day conversations to re-read an
		// image with tools; the OS temp cleaner is an additional floor.
		retentionHours: 168,
	},
	outbox: {
		maxAttempts: 50,
		backoffMaxMs: 60_000,
		retainDays: 7,
		pendingCap: 10_000,
		blobThreshold: 24_000,
	},
	supervisor: {
		probeIntervalMs: 30_000,
		probeTimeoutMs: 8_000,
		probeFailThreshold: 3,
		maxReconnectAttempts: 8,
		idleKeepaliveMs: 20 * 60_000,
	},
	quota: {
		windowMinutes: 60,
		limit: 12,
	},
	denyList: [],
	sessionIdleTtlMs: 30 * 60_000,
	maxSessions: 32,
	allowlist: [],
	workspaceRoot: "",
	agentPreset: "code",
	permissionMode: "danger-full-access",
};

/** Keys that may be hot-reloaded via /lark-config (whitelist, never credentials). */
export const HOT_RELOADABLE: ReadonlyArray<keyof FeishuConfig> = [
	"groupPolicy",
	"groupKeywords",
	"alsoOnReply",
	"workspaceRoot",
	"agentPreset",
	"permissionMode",
	"streaming",
	"reactions",
	"denyList",
	"allowlist",
	"attachments",
];

/**
 * Parse a /lark-config key path into a hot-reload patch.
 *
 * Accepts BOTH top-level keys ("denyList") and dotted paths under
 * object-valued whitelist keys ("streaming.enabled", "streaming.printStep") —
 * the dotted form is what users naturally type for the streaming knobs and
 * used to be rejected with 不可热改 because only the exact top-level names
 * were matched. Unknown top-level segments and unknown/over-deep nested keys
 * throw so typos never silently no-op.
 */
export function buildHotReloadPatch(
	key: string,
	value: unknown,
): Partial<FeishuConfig> {
	const segments = key.split(".").filter((s) => s !== "");
	if (segments.length === 0)
		throw new Error(`config key "${key}" is not hot-reloadable`);
	const head = segments[0] as string;
	const rest = segments.slice(1);
	if (!HOT_RELOADABLE.includes(head as never))
		throw new Error(`config key "${head}" is not hot-reloadable`);
	if (rest.length === 0) return { [head]: value } as Partial<FeishuConfig>;
	// Dotted path: only ONE level of nesting exists in FeishuConfig
	// (streaming.*, reactions.*, outbox.*, supervisor.*, quota.*) and the
	// nested record must already declare the sub-key.
	if (rest.length > 1)
		throw new Error(
			`config key "${key}" is unknown (FeishuConfig nests one level deep)`,
		);
	const nested = DEFAULT_CONFIG[head as keyof FeishuConfig] as Record<
		string,
		unknown
	>;
	const nestedKey = rest[0] as string;
	if (
		typeof nested !== "object" ||
		nested === null ||
		Array.isArray(nested) ||
		!(nestedKey in nested)
	)
		throw new Error(
			`config key "${key}" is unknown (not a configurable nested key)`,
		);
	return { [head]: { [nestedKey]: value } } as unknown as Partial<FeishuConfig>;
}

export function deepMerge<T>(base: T, over: Partial<T>): T {
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [k, v] of Object.entries(over ?? {})) {
		if (v === undefined) continue;
		const existing = out[k];
		if (
			existing !== null &&
			v !== null &&
			typeof existing === "object" &&
			typeof v === "object" &&
			!Array.isArray(existing) &&
			!Array.isArray(v)
		) {
			out[k] = deepMerge(
				existing as Record<string, unknown>,
				v as Record<string, unknown>,
			);
		} else {
			out[k] = v;
		}
	}
	return out as T;
}

export interface ConfigStore {
	get(): FeishuConfig;
	/** Hot reload a whitelisted partial; returns the effective config. */
	update(partial: Partial<FeishuConfig>): FeishuConfig;
	/** Persist the current config to disk (for hot overrides). */
	save(): void;
	/** Persist overrides to the runtime-overrides.json. */
	saveOverrides(): void;
	path(): string;
}

export function createConfigStore(
	stateDir: string,
	initialOverrides?: Partial<FeishuConfig>,
): ConfigStore {
	const overridesPath = join(stateDir, "runtime-overrides.json");
	mkdirSync(dirname(overridesPath), { recursive: true });

	let overrides: Partial<FeishuConfig> = { ...(initialOverrides ?? {}) };
	try {
		const raw = readFileSync(overridesPath, "utf8");
		const parsed = JSON.parse(raw) as Partial<FeishuConfig>;
		overrides = deepMerge(overrides, parsed);
	} catch {
		// first run — no overrides file yet
	}

	const get = (): FeishuConfig => deepMerge(DEFAULT_CONFIG, overrides);
	const persist = (file: string, data: unknown): void => {
		try {
			writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
		} catch {
			// best-effort persistence; hot reload still works in-memory
		}
	};

	return {
		get,
		update(partial) {
			for (const key of Object.keys(partial) as Array<keyof FeishuConfig>) {
				if (!HOT_RELOADABLE.includes(key)) {
					throw new Error(`config key "${key}" is not hot-reloadable`);
				}
			}
			overrides = deepMerge(overrides, partial as Partial<FeishuConfig>);
			return get();
		},
		save() {
			persist(join(stateDir, "config.json"), get());
		},
		saveOverrides() {
			persist(overridesPath, overrides);
		},
		path: () => overridesPath,
	};
}
