import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import pino from "pino";

export function createLogger({ level, logToFile, logDir }) {
  if (!logToFile) {
    return pino({ level });
  }

  const resolvedDir = path.resolve(process.cwd(), logDir || "./logs");
  fs.mkdirSync(resolvedDir, { recursive: true });

  const streams = [
    { stream: pino.destination(1) },
    { stream: pino.destination(path.join(resolvedDir, "app.log")) },
    { level: "error", stream: pino.destination(path.join(resolvedDir, "errors.log")) }
  ];

  return pino({ level }, pino.multistream(streams));
}

export function attachProcessHandlers(logger) {
  process.on("unhandledRejection", err => {
    logger.error({ err }, "unhandledRejection");
  });

  process.on("uncaughtException", err => {
    logger.error({ err }, "uncaughtException");
    process.exit(1);
  });
}
