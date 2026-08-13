// Reaction receipts: random reaction on inbound (pool excludes the DONE
// marker), ✅ only on task completion. Contains only Feishu-valid emoji types
// (pi-feishu-link F2 lesson: invalid types like FIRE/AMAZE/AWESOME/COOL cause
// addReaction 231001).
// Harness-agnostic pure module.

/** Validated set: every type here is known-good with im:message.reactions. */
export const VALID_EMOJI_TYPES: readonly string[] = [
  "THUMBSUP",
  "OK",
  "HEART",
  "SMILE",
  "LAUGH",
  "FIRE",
  "CLAP",
  "ROCKET",
  "SUN",
  "SURPRISE",
  "PRAY",
  "WHITE_CHECK_MARK",
] as const;

export interface ReactionPicker {
  /** Random receipt reaction — never the DONE marker. */
  pickRandom(): string | undefined;
  /** Completion marker reaction. */
  done(): string;
}

/**
 * Build a reaction picker from a configured pool. Filters out any type not in
 * VALID_EMOJI_TYPES (fail-safe: a stale config cannot 400 the bridge) AND the
 * DONE marker (ADR-9: completion marker never participates in the random pool);
 * falls back to the default pool when nothing valid remains.
 */
export function createReactionPicker(pool: readonly string[], done: string): ReactionPicker {
  const validPool = pool.filter(
    (t) => (VALID_EMOJI_TYPES as readonly string[]).includes(t) && t !== done,
  );
  const effectivePool = validPool.length > 0 ? validPool : DEFAULT_RANDOM_POOL.filter((t) => t !== done);
  const effectiveDone = (VALID_EMOJI_TYPES as readonly string[]).includes(done)
    ? done
    : DEFAULT_DONE;
  return {
    pickRandom() {
      if (effectivePool.length === 0) return undefined;
      return effectivePool[Math.floor(Math.random() * effectivePool.length)];
    },
    done: () => effectiveDone,
  };
}

export const DEFAULT_RANDOM_POOL: readonly string[] = [
  "THUMBSUP",
  "OK",
  "HEART",
  "SMILE",
  "FIRE",
  "CLAP",
  "ROCKET",
  "SUN",
];
export const DEFAULT_DONE = "WHITE_CHECK_MARK";
