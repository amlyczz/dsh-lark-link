// Tiny structured logger with scoped prefixes and optional file sink.
// Harness-agnostic.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export function createLogger(scope: string, minLevel: LogLevel = "info"): Logger {
  const levelRank: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const emit = (level: LogLevel, msg: string, meta?: Record<string, unknown>): void => {
    if (levelRank[level] < levelRank[minLevel]) return;
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${scope}] ${msg}${
      meta ? ` ${JSON.stringify(meta)}` : ""
    }`;
    if (level === "error") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  };
  return {
    debug: (m, meta) => emit("debug", m, meta),
    info: (m, meta) => emit("info", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    error: (m, meta) => emit("error", m, meta),
  };
}

/** In-memory logger capturing lines for diagnostics/testing. */
export function createCapturingLogger(scope: string): Logger & { lines: string[] } {
  const base = createLogger(scope, "debug");
  const lines: string[] = [];
  const wrap = (level: LogLevel, m: string, meta?: Record<string, unknown>): void => {
    lines.push(`${level}:${m}`);
    if (level === "error") base.error(m, meta);
    else if (level === "warn") base.warn(m, meta);
    else if (level === "debug") base.debug(m, meta);
    else base.info(m, meta);
  };
  return {
    lines,
    debug: (m, meta) => wrap("debug", m, meta),
    info: (m, meta) => wrap("info", m, meta),
    warn: (m, meta) => wrap("warn", m, meta),
    error: (m, meta) => wrap("error", m, meta),
  };
}
