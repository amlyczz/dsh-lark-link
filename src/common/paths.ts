// Cross-platform workspace path resolution (GH #7).
//
// The /workspace command and the lark_send_local_file tool used to test
// absoluteness with `startsWith("/")` — a Unix-only heuristic. On Windows
// every absolute path starts with a drive letter (`D:\…`) or a UNC share
// (`\\server\…`), so the command rejected EVERY path with 无效路径 and the
// file tool joined drive paths under the workspace root and then rejected
// them as out-of-workspace.
//
// node:path already knows: isAbsolute() is platform-correct, and win32
// absoluteness is additionally recognized on every platform so a Windows-style
// path typed into a Linux-hosted bridge surfaces as "directory not found"
// instead of a garbage joined path. Containment uses relative() — prefix
// string matching breaks on case/separator variance.

import { isAbsolute, join, resolve, relative, win32 } from "node:path";
import { homedir } from "node:os";

/** True for a path that is absolute on the CURRENT platform OR Windows-shaped
 * (drive letter / UNC) — a superset check so drive paths never get joined
 * under a Unix cwd (GH #7). */
export function isAbsoluteAny(p: string): boolean {
	return isAbsolute(p) || win32.isAbsolute(p);
}

/**
 * Resolve a /workspace argument against the current workspace (GH #7).
 * - `~` / `~/…` expands to the user's home directory
 * - absolute (posix OR windows drive/UNC) stays verbatim (normalized)
 * - anything else joins onto curWs
 */
export function resolveWorkspaceTarget(arg: string, curWs: string): string {
	const expanded =
		arg === "~" || arg.startsWith("~/")
			? join(homedir(), arg.slice(arg.startsWith("~/") ? 2 : 1))
			: arg;
	if (!isAbsoluteAny(expanded)) return resolve(join(curWs, expanded));
	// Windows-shaped on a posix host (or vice versa): normalize in ITS shape
	// and return verbatim — never let resolve() fold it under a foreign root.
	if (win32.isAbsolute(expanded) && !isAbsolute(expanded))
		return win32.normalize(expanded);
	return resolve(expanded);
}

/**
 * Resolve a file path for the lark_send_local_file tool and check that it
 * stays inside the workspace root (GH #7).
 * Returns { abs, ok } — ok=false means the path escapes the workspace and
 * must be rejected (拒绝: 路径不在工作区内).
 */
export function resolveInWorkspacePath(
	p: string,
	root: string,
): { abs: string; ok: boolean } {
	const abs = isAbsoluteAny(p) ? resolveWorkspaceTarget(p, root) : resolve(join(root, p));
	// Containment via relative(): safe against case and separator variance.
	// Pick the family that matches the inputs so drive-letter roots compare
	// correctly even when the host is posix.
	const useWin = win32.isAbsolute(root) || win32.isAbsolute(abs);
	const rel = useWin ? win32.relative(root, abs) : relative(root, abs);
	const ok =
		rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !win32.isAbsolute(rel));
	return { abs, ok };
}
