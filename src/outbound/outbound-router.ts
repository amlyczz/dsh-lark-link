// OutboundRouter: routes outbound envelopes by sessionKey and keeps the
// route table (routes.json) + 30d sent-dedupe for delivery. Also routes
// scheduled-task results back to their originating chat. Harness-agnostic.

import { readFileSync, writeFileSync } from "node:fs";
import type { Route } from "../common/types.ts";

export interface RouteStore {
  get(key: string): Route | undefined;
  all(): Route[];
  upsert(route: Route): void;
  touch(key: string, lastMessageId?: string): void;
  remove(key: string): void;
  prune(maxAgeMs: number): void;
  persist(): void;
}

export function createRouteStore(file: string, now: () => number = Date.now): RouteStore {
  let routes = new Map<string, Route>();
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Route[];
    routes = new Map(parsed.map((r) => [r.sessionKey, r]));
  } catch {
    routes = new Map();
  }

  const persist = (): void => {
    try {
      writeFileSync(file, JSON.stringify([...routes.values()], null, 2), { mode: 0o600 });
    } catch {
      // best-effort
    }
  };

  return {
    get(key) {
      return routes.get(key);
    },
    all() {
      return [...routes.values()];
    },
    upsert(route) {
      routes.set(route.sessionKey, route);
      persist();
    },
    touch(key, lastMessageId) {
      const r = routes.get(key);
      if (!r) return;
      r.updatedAt = now();
      if (lastMessageId !== undefined) r.lastMessageId = lastMessageId;
      persist();
    },
    remove(key) {
      routes.delete(key);
      persist();
    },
    prune(maxAgeMs) {
      const cutoff = now() - maxAgeMs;
      let changed = false;
      for (const [k, r] of routes) {
        if (r.updatedAt < cutoff) {
          routes.delete(k);
          changed = true;
        }
      }
      if (changed) persist();
    },
    persist,
  };
}
