/**
 * Log levels shared by the CLI (`--log-level`) and the library
 * (`createEngine({ log })`). Levels nest: `error` prints failures only,
 * `info` adds the run narrative (model resolution, step rows, warnings),
 * `debug` adds the engine's own trace (graph wiring, per-node timings).
 * `silent` prints nothing; the exit code and `result.json` carry the outcome.
 */

export type LogLevel = 'silent' | 'error' | 'info' | 'debug';
/** The level a single message is written at (a message is never "silent"). */
export type MessageLevel = Exclude<LogLevel, 'silent'>;

export const LOG_LEVELS: readonly LogLevel[] = ['silent', 'error', 'info', 'debug'];

const RANK: Record<LogLevel, number> = { silent: 0, error: 1, info: 2, debug: 3 };

/** A log sink: receives every message with its level; filtering is the sink's choice. */
export type LogSink = (message: string, level: MessageLevel) => void;

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/** Whether a message at `level` is shown under a configured `threshold`. */
export function levelEnabled(threshold: LogLevel, level: MessageLevel): boolean {
  return RANK[level] <= RANK[threshold];
}

export interface Logger {
  readonly level: LogLevel;
  error(message: string): void;
  info(message: string): void;
  debug(message: string): void;
  /** Whether messages at `level` are written. */
  enabled(level: MessageLevel): boolean;
  /** The logger as a sink for `createEngine({ log })` and the engine core. */
  sink: LogSink;
}

/**
 * A logger over a threshold and a writer (default: one line on stderr). A
 * `LogSink` given instead of a level receives everything and filters itself.
 */
export function createLogger(
  levelOrSink: LogLevel | LogSink = 'silent',
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Logger {
  if (typeof levelOrSink === 'function') {
    const sink = levelOrSink;
    return {
      level: 'debug',
      error: (m) => sink(m, 'error'),
      info: (m) => sink(m, 'info'),
      debug: (m) => sink(m, 'debug'),
      enabled: () => true,
      sink,
    };
  }
  const level = levelOrSink;
  const emit = (m: string, l: MessageLevel): void => {
    if (levelEnabled(level, l)) write(m);
  };
  return {
    level,
    error: (m) => emit(m, 'error'),
    info: (m) => emit(m, 'info'),
    debug: (m) => emit(m, 'debug'),
    enabled: (l) => levelEnabled(level, l),
    sink: emit,
  };
}
