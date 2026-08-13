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
		enabled: false;
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
}

export const DEFAULT_CONFIG: FeishuConfig = {
	credentialRef: "LARK_LINK_APP",
	groupPolicy: "mention",
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
		// 8 validated emoji types (pi-feishu-link F2 fix: only real, tested types).
		pool: ["THUMBSUP", "OK", "HEART", "SMILE", "FIRE", "CLAP", "ROCKET", "SUN"],
		done: "WHITE_CHECK_MARK",
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
};

/** Keys that may be hot-reloaded via /lark-config (whitelist, never credentials). */
export const HOT_RELOADABLE: ReadonlyArray<keyof FeishuConfig> = [
	"groupPolicy",
	"groupKeywords",
	"alsoOnReply",
	"streaming",
	"reactions",
	"denyList",
	"allowlist",
];

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
