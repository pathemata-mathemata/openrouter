import fastify from "fastify";
import fs from "node:fs";
import { config } from "./config.js";
import { createDecisionCache } from "./cache.js";
import { classifyRequest, warmUpClassifier } from "./classifier.js";
import { hashPayload, nowMs } from "./utils.js";
import { getProviderAdapter } from "./providers/index.js";
import { createLogger, attachProcessHandlers } from "./logging.js";
import { snapshotUsage } from "./token_tracker.js";

const logger = createLogger({
  level: config.logLevel,
  logToFile: config.logToFile,
  logDir: config.logDir
});

const app = fastify({
  logger,
  bodyLimit: config.bodyLimit
});

attachProcessHandlers(app.log);

const cache = await createDecisionCache(config.cache, app.log);
const dashboardHtml = fs.readFileSync(new URL("./dashboard.html", import.meta.url), "utf8");

app.addHook("onRequest", async (req, reply) => {
  if (!config.routerApiKey) return;
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  if (token !== config.routerApiKey) {
    reply.code(401).send({ error: "unauthorized" });
  }
});

app.get("/health", async () => {
  return {
    status: "ok",
    classifierEnabled: config.classifier.enabled,
    classifier: config.classifier.baseUrl,
    cheap: config.upstreams.cheap?.baseUrl,
    medium: config.upstreams.medium?.baseUrl,
    frontier: config.upstreams.frontier?.baseUrl
  };
});

app.get("/usage", async () => {
  return snapshotUsage();
});

app.get("/dashboard", async (req, reply) => {
  reply.type("text/html").send(dashboardHtml);
});

app.post("/v1/chat/completions", async (req, reply) => {
  const payload = req.body;
  const start = nowMs();

  if (!payload || !payload.messages) {
    reply.code(400).send({ error: "invalid_request" });
    return;
  }

  let decision = 2;

  if (config.classifier.enabled) {
    const hash = hashPayload(payload);
    decision = null;

    if (config.cache.enabled) {
      const cached = await cache.get(hash);
      if (cached !== null) {
        decision = Number(cached);
      }
    }

    if (decision === null || Number.isNaN(decision)) {
      try {
        decision = await classifyRequest(payload, config.classifier, app.log);
        if (config.cache.enabled) {
          await cache.set(hash, String(decision));
        }
      } catch (err) {
        app.log.warn({ err }, "classifier failed, falling back to frontier");
        decision = 2;
      }
    }
  }

  let route = "frontier";
  if (decision === 0) route = "cheap";
  if (decision === 1) route = "medium";
  const upstream = config.upstreams[route];
  const adapter = getProviderAdapter(upstream);
  return adapter({
    payload,
    upstream,
    reply,
    logger: app.log,
    config,
    decision,
    route,
    start
  });
});

app.setErrorHandler((err, req, reply) => {
  app.log.error(
    { err, reqId: req.id, method: req.method, url: req.url },
    "request error"
  );
  if (!reply.sent) {
    reply.code(500).send({ error: "internal_error" });
  }
});

app
  .listen({ host: config.host, port: config.port })
  .then(() => {
    if (config.classifier.enabled && config.classifier.warmup) {
      const delay = config.classifier.warmupDelayMs ?? 0;
      setTimeout(() => {
        void warmUpClassifier(config.classifier, app.log);
      }, delay);
    }

    if (config.classifier.enabled && config.classifier.keepAliveMs > 0) {
      const interval = setInterval(() => {
        void warmUpClassifier(config.classifier, app.log);
      }, config.classifier.keepAliveMs);
      interval.unref?.();
    }
  })
  .catch(err => {
    app.log.error({ err }, "failed to start server");
    process.exit(1);
  });
