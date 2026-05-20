import pino from "pino";
import type { Logger } from "./adapters/types.js";

const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport: isDev
    ? { target: "pino-pretty", options: { colorize: true } }
    : undefined,
});

/**
 * Create a child Logger (msg-first interface) scoped to an adapter run.
 * Adapts pino's native (obj, msg) order to the adapter interface's (msg, obj).
 */
export function adapterLogger(adapterId: string): Logger {
  const child = logger.child({ adapter: adapterId });
  return {
    info: (msg, obj) => child.info(obj ?? {}, msg),
    warn: (msg, obj) => child.warn(obj ?? {}, msg),
    error: (msg, obj) => child.error(obj ?? {}, msg),
    debug: (msg, obj) => child.debug(obj ?? {}, msg),
  };
}
