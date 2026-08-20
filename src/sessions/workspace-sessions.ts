// Workspace session listing for the Feishu-side /resume command.
//
// Lists the HISTORICAL DSH sessions of one workspace (cwd) so a Feishu chat can
// pick one up again. Two layered sources (same discipline as doctor's export):
//
//   1. sessionPersistence service (preferred): headers carry createdAt, cwd,
//      agentPreset and origin — exact cwd equality, subagent children excluded.
//   2. filesystem scan (fallback): <DSH_HOME>/sessions/<projectKey(cwd)>/<encoded-id>/
//      session.jsonl.zstd, decoded + mtime-sorted. The projectKey encoding is
//      ported VERBATIM from dsh-session-persistence-jsonl (lossy by design —
//      separators collapse, unsafe code units escape as ~XXXX) so the scan
//      lands in exactly the directory DSH writes.
//
// Harness-agnostic: the service is injected as a narrow structural interface.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Header-like row of the DSH sessionPersistence service (structural slice). */
export interface SessionHeaderLike {
	id: string;
	createdAt: number;
	cwd?: string;
	agentPreset?: string;
	origin?: string;
}

export interface WorkspaceSessionInfo {
	id: string;
	/** epoch ms — header createdAt (service) or log mtime (scan). */
	createdAt: number;
	/** stored agentPreset — present on the service source only. */
	preset?: string;
	source: "service" | "scan";
}

export interface PersistenceListSource {
	list(signal?: AbortSignal): Promise<SessionHeaderLike[]>;
}

export interface ListWorkspaceSessionsDeps {
	/** DSH sessions root — <DSH_HOME>/sessions. */
	sessionsRoot: string;
	/** the workspace whose sessions to list. */
	cwd: string;
	/** live sessionPersistence service (optional — scan fallback otherwise). */
	persistence?: PersistenceListSource;
	/** ids to hide (e.g. this conversation's CURRENT session). */
	exclude?: string[];
	/** cap (default 10). */
	limit?: number;
}

/**
 * Port of dsh-session-persistence-jsonl's projectKey: `/`, `\` and `:` become
 * `-` (consecutive runs collapse), safe `[A-Za-z0-9._-]` passes, everything
 * else escapes as `~XXXX` (uppercase hex code unit); wrapped `--…--` with the
 * readable part bounded to 251 chars and `root` when empty.
 */
export function projectKeyOf(cwd: string): string {
	if (cwd.length === 0) throw new Error("cannot encode an empty project path");
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const ch = cwd[i] as string;
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += `~${cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0")}`;
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** Decode an encoded session dir name (`~003A` → `:` etc.). */
export function decodeSessionDirName(name: string): string {
	return name.replace(/~([0-9A-Fa-f]{4})/g, (_m, hex: string) =>
		String.fromCharCode(Number.parseInt(hex, 16)),
	);
}

/** List historical sessions of one workspace, newest first, capped. */
export async function listWorkspaceSessions(
	deps: ListWorkspaceSessionsDeps,
): Promise<WorkspaceSessionInfo[]> {
	const limit = deps.limit ?? 10;
	const exclude = new Set(deps.exclude ?? []);

	// Source 1: the persistence service — headers give exact cwd + origin.
	if (deps.persistence?.list) {
		try {
			const headers = await deps.persistence.list();
			const rows = headers
				.filter(
					(h) =>
						h.cwd === deps.cwd &&
						h.origin !== "subagent" &&
						!exclude.has(h.id),
				)
				.sort((a, b) => b.createdAt - a.createdAt)
				.slice(0, limit)
				.map<WorkspaceSessionInfo>((h) => ({
					id: h.id,
					createdAt: h.createdAt,
					...(h.agentPreset ? { preset: h.agentPreset } : {}),
					source: "service",
				}));
			return rows;
		} catch {
			// fall through to the filesystem scan
		}
	}

	// Source 2: filesystem scan of <sessionsRoot>/<projectKey(cwd)>/.
	const dir = join(deps.sessionsRoot, projectKeyOf(deps.cwd));
	if (!existsSync(dir)) return [];
	const rows: WorkspaceSessionInfo[] = [];
	for (const name of readdirSync(dir)) {
		const log = join(dir, name, "session.jsonl.zstd");
		let mtime: number;
		try {
			mtime = statSync(log).mtimeMs;
		} catch {
			continue; // no materialized log — not resumable
		}
		const id = decodeSessionDirName(name);
		if (exclude.has(id)) continue;
		rows.push({ id, createdAt: mtime, source: "scan" });
	}
	rows.sort((a, b) => b.createdAt - a.createdAt);
	return rows.slice(0, limit);
}
