import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

function env(name, fallback = undefined) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function envInt(name, fallback) {
  const value = env(name, undefined);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function envFloat(name, fallback) {
  const value = env(name, undefined);
  if (value === undefined) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function envBool(name, fallback) {
  const value = env(name, undefined);
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true" || value === "1";
}

function parseJson(name) {
  const value = env(name, undefined);
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Invalid JSON in ${name}`);
  }
}

function readJsonFile(filePath) {
  if (!filePath) return null;
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) return null;
  try {
    const content = fs.readFileSync(resolved, "utf8");
    return JSON.parse(content);
  } catch {
    throw new Error(`Invalid JSON in ${resolved}`);
  }
}

function normalizeBaseUrl(url) {
  if (!url) return url;
  return url.replace(/\/+$/, "");
}

function resolveChatUrl(baseUrl) {
  const url = new URL(normalizeBaseUrl(baseUrl));
  let path = url.pathname.replace(/\/+$/, "");
  if (path === "" || path === "/") {
    path = "/v1";
  }
  if (!path.endsWith("/v1")) {
    path = `${path}/v1`;
  }
  url.pathname = `${path}/chat/completions`;
  return url.toString();
}

function buildUpstreams() {
  const cheap = {
    name: env("CHEAP_NAME", "cheap"),
    provider: env("CHEAP_PROVIDER", ""),
    baseUrl: env("CHEAP_BASE_URL", env("CLASSIFIER_BASE_URL", null)),
    apiKey: env("CHEAP_API_KEY", ""),
    model: env("CHEAP_MODEL", null),
    apiVersion: env("CHEAP_API_VERSION", ""),
    deployment: env("CHEAP_DEPLOYMENT", ""),
    headers: parseJson("CHEAP_HEADERS"),
    timeoutMs: envInt("CHEAP_TIMEOUT_MS", envInt("UPSTREAM_TIMEOUT_MS", 30000))
  };

  const medium = {
    name: env("MEDIUM_NAME", "medium"),
    provider: env("MEDIUM_PROVIDER", ""),
    baseUrl: env("MEDIUM_BASE_URL", null),
    apiKey: env("MEDIUM_API_KEY", ""),
    model: env("MEDIUM_MODEL", null),
    apiVersion: env("MEDIUM_API_VERSION", ""),
    deployment: env("MEDIUM_DEPLOYMENT", ""),
    headers: parseJson("MEDIUM_HEADERS"),
    timeoutMs: envInt("MEDIUM_TIMEOUT_MS", envInt("UPSTREAM_TIMEOUT_MS", 45000))
  };

  const frontier = {
    name: env("FRONTIER_NAME", "frontier"),
    provider: env("FRONTIER_PROVIDER", ""),
    baseUrl: env("FRONTIER_BASE_URL", null),
    apiKey: env("FRONTIER_API_KEY", ""),
    model: env("FRONTIER_MODEL", null),
    apiVersion: env("FRONTIER_API_VERSION", ""),
    deployment: env("FRONTIER_DEPLOYMENT", ""),
    headers: parseJson("FRONTIER_HEADERS"),
    timeoutMs: envInt("FRONTIER_TIMEOUT_MS", envInt("UPSTREAM_TIMEOUT_MS", 60000))
  };

  const upstreamsFile = env("UPSTREAMS_FILE", "");
  const fileJson =
    readJsonFile(upstreamsFile) ||
    readJsonFile("upstreams.json");
  if (fileJson && typeof fileJson === "object") {
    return {
      cheap: normalizeUpstream(fileJson.cheap, cheap),
      medium: normalizeUpstream(fileJson.medium, medium),
      frontier: normalizeUpstream(fileJson.frontier, frontier)
    };
  }

  const json = parseJson("UPSTREAMS_JSON");
  if (json && typeof json === "object") {
    return {
      cheap: normalizeUpstream(json.cheap, cheap),
      medium: normalizeUpstream(json.medium, medium),
      frontier: normalizeUpstream(json.frontier, frontier)
    };
  }

  return { cheap, medium, frontier };
}

function normalizeUpstream(input, fallback) {
  if (input === null) return null;
  if (!input) return fallback;
  return {
    name: input.name ?? fallback.name,
    provider: input.provider ?? fallback.provider,
    baseUrl: input.baseUrl ?? fallback.baseUrl,
    apiKey: input.apiKey ?? fallback.apiKey,
    model: input.model ?? fallback.model,
    apiVersion: input.apiVersion ?? fallback.apiVersion,
    deployment: input.deployment ?? fallback.deployment,
    headers: input.headers ?? fallback.headers,
    timeoutMs: input.timeoutMs ?? fallback.timeoutMs
  };
}

const upstreams = buildUpstreams();

export const config = {
  host: env("HOST", "0.0.0.0"),
  port: envInt("PORT", 3000),
  bodyLimit: envInt("BODY_LIMIT", 5_000_000),
  routerApiKey: env("ROUTER_API_KEY", ""),
  logLevel: env("LOG_LEVEL", "info"),
  logToFile: envBool("LOG_TO_FILE", true),
  logDir: env("LOG_DIR", "./logs"),
  decisionHeader: env("DECISION_HEADER", "x-openrouter-decision"),
  upstreamHeader: env("UPSTREAM_HEADER", "x-openrouter-upstream"),
  classifier: {
    enabled: envBool("CLASSIFIER_ENABLED", true),
    baseUrl: env("CLASSIFIER_BASE_URL", null),
    apiKey: env("CLASSIFIER_API_KEY", ""),
    model: env("CLASSIFIER_MODEL", "meta-llama/Meta-Llama-3.1-8B-Instruct"),
    systemPrompt: env(
      "CLASSIFIER_SYSTEM_PROMPT",
      "You are a routing classifier. Return only 0, 1, or 2. 0 = simple/cheap tasks. 1 = medium tasks. 2 = complex/frontier tasks."
    ),
    strategy: env("CLASSIFIER_STRATEGY", "last_user"),
    maxTokens: envInt("CLASSIFIER_MAX_TOKENS", 1),
    maxChars: envInt("CLASSIFIER_MAX_CHARS", 8000),
    temperature: envFloat("CLASSIFIER_TEMPERATURE", 0),
    timeoutMs: envInt("CLASSIFIER_TIMEOUT_MS", 800),
    logitBias: parseJson("CLASSIFIER_LOGIT_BIAS"),
    forceStream: envBool("CLASSIFIER_FORCE_STREAM", true),
    warmup: envBool("CLASSIFIER_WARMUP", true),
    warmupDelayMs: envInt("CLASSIFIER_WARMUP_DELAY_MS", 250),
    keepAliveMs: envInt("CLASSIFIER_KEEP_ALIVE_MS", 0),
    loadingRetryMs: envInt("CLASSIFIER_LOADING_RETRY_MS", 1200),
    loadingMaxRetries: envInt("CLASSIFIER_LOADING_MAX_RETRIES", 2)
  },
  cache: {
    redisUrl: env("REDIS_URL", ""),
    ttlMs: envInt("CACHE_TTL_MS", 60 * 60 * 1000),
    maxEntries: envInt("CACHE_MAX", 50_000),
    enabled: envBool("CACHE_ENABLED", true)
  },
  azureApiVersion: env("AZURE_API_VERSION", "2024-10-21"),
  anthropicVersion: env("ANTHROPIC_VERSION", "2023-06-01"),
  upstreams,
  resolveChatUrl
};

if (
  config.classifier.enabled &&
  config.upstreams.cheap?.baseUrl &&
  config.classifier.baseUrl
) {
  const cheapBase = normalizeBaseUrl(config.upstreams.cheap.baseUrl);
  const classifierBase = normalizeBaseUrl(config.classifier.baseUrl);
  if (cheapBase && classifierBase && cheapBase === classifierBase) {
    config.upstreams.cheap.model = config.classifier.model;
  }
}

if (config.classifier.enabled && !config.classifier.baseUrl) {
  throw new Error("CLASSIFIER_BASE_URL is required");
}

if (!config.upstreams.frontier?.baseUrl) {
  throw new Error("FRONTIER_BASE_URL (or UPSTREAMS_JSON.frontier.baseUrl) is required");
}

if (config.classifier.enabled && !config.upstreams.cheap?.baseUrl) {
  throw new Error("CHEAP_BASE_URL or CLASSIFIER_BASE_URL is required for cheap route");
}

if (config.classifier.enabled && !config.upstreams.medium?.baseUrl) {
  throw new Error("MEDIUM_BASE_URL is required for medium route");
}

export { resolveChatUrl };
