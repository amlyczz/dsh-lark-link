// ConversationConfigStore: per-conversation-key overrides for the session
// scoping knobs (workspace root / model / agent preset). Previously these
// lived ONLY in the bridge-level FeishuConfig, so /workspace or /model in one
// Feishu chat silently switched EVERY other chat's agent on its next rebuild
// (idle-TTL eviction, /new, /mode, maxSessions pressure). This store gives
// each conversation its own override, resolved as:
//   per-key override ?? bridge global default
// Persisted as JSON so overrides survive restarts. Harness-agnostic.

import { readFileSync, writeFileSync } from "node:fs";

export interface ConversationOverrides {
	/** Session cwd for this conversation (undefined = bridge default). */
	workspaceRoot?: string;
	/** Model provider for this conversation (undefined = bridge default). */
	provider?: string;
	/** Model id for this conversation (undefined = bridge default). */
	model?: string;
	/** Agent preset id for this conversation (undefined = bridge default). */
	preset?: string;
	/** Active session id for this conversation (survives dsh restarts to continue conversation). */
	activeSessionId?: string;
}

export interface ConversationConfigStore {
	/** Live override record for a key (empty object when none). */
	get(key: string): ConversationOverrides;
	/** Merge partial overrides for a key and persist. */
	set(key: string, partial: ConversationOverrides): void;
	/** Clear all overrides for a key. */
	clear(key: string): void;
	/** All keys that currently carry at least one override. */
	keys(): string[];
}

export function createConversationConfigStore(
	file: string,
): ConversationConfigStore {
	let data: Record<string, ConversationOverrides> = {};
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<
			string,
			ConversationOverrides
		>;
		if (parsed && typeof parsed === "object") data = parsed;
	} catch {
		// first run — no file yet
	}

	const persist = (): void => {
		try {
			writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
		} catch {
			// best-effort; in-memory overrides still work
		}
	};

	const clean = (o: ConversationOverrides): ConversationOverrides => {
		const out: ConversationOverrides = {};
		if (o.workspaceRoot) out.workspaceRoot = o.workspaceRoot;
		if (o.provider) out.provider = o.provider;
		if (o.model) out.model = o.model;
		if (o.preset) out.preset = o.preset;
		if (o.activeSessionId) out.activeSessionId = o.activeSessionId;
		return out;
	};

	return {
		get(key) {
			return data[key] ? { ...data[key] } : {};
		},
		set(key, partial) {
			const merged = clean({ ...(data[key] ?? {}), ...partial });
			if (Object.keys(merged).length === 0) delete data[key];
			else data[key] = merged;
			persist();
		},
		clear(key) {
			delete data[key];
			persist();
		},
		keys() {
			return Object.keys(data);
		},
	};
}
