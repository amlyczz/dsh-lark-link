// TurnSupervisor: watchdog for agent turns. If a turn runs longer than the
// timeout (model hang, stuck tool), dispose the active agent so the
// conversation unlocks (FIFO can proceed). Harness-agnostic.

import type { DshSessionBackend } from "./dsh-session-backend.ts";

export interface TurnSupervisorDeps {
  backend: DshSessionBackend;
  timeoutMs: number;
  now?: () => number;
  logger?: { warn(msg: string): void; info(msg: string): void };
}

export interface TurnSupervisor {
  /** Arm a watchdog for the next turn of a conversation key. */
  arm(key: string): void;
  /** Cancel a pending watchdog for a key (called on turn/end). */
  disarm(key: string): void;
  /** Start periodic sweeping (unref'd interval). */
  start(): void;
  stop(): void;
}

export function createTurnSupervisor(deps: TurnSupervisorDeps): TurnSupervisor {
  const now = deps.now ?? Date.now;
  const armed = new Map<string, number>(); // key -> armedAt
  let timer: NodeJS.Timeout | undefined;

  return {
    arm(key) {
      armed.set(key, now());
    },
    disarm(key) {
      armed.delete(key);
    },
    start() {
      if (timer) return;
      timer = setInterval(() => {
        const cutoff = now() - deps.timeoutMs;
        for (const [key, armedAt] of armed) {
          if (armedAt < cutoff) {
            armed.delete(key);
            deps.logger?.warn(`turn timeout for ${key}; disposing agent to unlock`);
            const agent = deps.backend.get(key);
            if (agent) {
              void agent.dispose().then(() => {
                deps.logger?.info(`disposed agent for ${key} after turn timeout`);
              });
            }
          }
        }
      }, 1000);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      armed.clear();
    },
  };
}
