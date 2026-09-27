import pino from "pino";
import type { TelemetryEvent } from "../types.js";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
});

const recent: TelemetryEvent[] = [];

export function emitTelemetry(ev: TelemetryEvent): void {
  recent.push(ev);
  if (recent.length > 200) recent.shift();
  logger.info(ev);
}

export function recentTelemetry(): TelemetryEvent[] {
  return [...recent].reverse().slice(0, 100);
}
