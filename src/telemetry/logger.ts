import type { TelemetryEvent } from "../types.js";

const LEVEL = process.env.LOG_LEVEL || "info";
const debug = LEVEL === "debug";

export const logger = {
  info: (obj: unknown, msg?: string): void => {
    if (msg !== undefined) console.log(JSON.stringify({ level: "info", msg, ...((obj as Record<string, unknown>) || {}) }));
    else console.log(JSON.stringify(obj));
  },
  error: (e: unknown): void => console.error(e instanceof Error ? (e.stack || e.message) : e),
  debug: (...args: unknown[]): void => {
    if (debug) console.debug(...args);
  },
};

const recent: TelemetryEvent[] = [];

export function emitTelemetry(ev: TelemetryEvent): void {
  recent.push(ev);
  if (recent.length > 200) recent.shift();
  logger.info(ev);
}

export function recentTelemetry(): TelemetryEvent[] {
  return [...recent].reverse().slice(0, 100);
}
