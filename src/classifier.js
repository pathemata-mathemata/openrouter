import { buildClassifierInput, extractDecision, nowMs } from "./utils.js";
import { resolveChatUrl } from "./config.js";

export async function classifyRequest(payload, config, logger) {
  const start = nowMs();
  try {
    const input = buildClassifierInput(payload, config.strategy, config.maxChars);
    const messages = [
      { role: "system", content: config.systemPrompt },
      {
        role: "user",
        content: `Return only 0, 1, or 2. Input:\n${input}`
      }
    ];

    let loadingRetries = 0;
    let timeoutRetried = false;
    let currentConfig = config;

    while (true) {
      try {
        const decision = await attemptClassification(messages, currentConfig);
        logger.debug({ decision, ms: nowMs() - start }, "classifier decision");
        return decision;
      } catch (err) {
        if (isAbortError(err) && !timeoutRetried) {
          const retryTimeout = Math.max(currentConfig.timeoutMs * 2, 8000);
          timeoutRetried = true;
          logger.warn(
            { err, timeoutMs: currentConfig.timeoutMs, retryTimeoutMs: retryTimeout },
            "classifier timeout, retrying once"
          );
          currentConfig = { ...currentConfig, timeoutMs: retryTimeout };
          continue;
        }

        if (isModelLoadingError(err)) {
          const maxRetries = currentConfig.loadingMaxRetries ?? 1;
          if (loadingRetries < maxRetries) {
            loadingRetries += 1;
            const delay = currentConfig.loadingRetryMs ?? 1000;
            logger.warn(
              { err, delayMs: delay, attempt: loadingRetries, maxRetries },
              "classifier model loading, retrying"
            );
            await sleep(delay);
            continue;
          }
        }

        throw err;
      }
    }
  } finally {
  }
}

export async function warmUpClassifier(config, logger) {
  if (!config?.baseUrl || !config?.model) return;
  const warmupTimeout = Math.max(Number(config.timeoutMs || 0) * 2, 10000);
  const warmupConfig = { ...config, timeoutMs: warmupTimeout };
  const messages = [
    {
      role: "system",
      content:
        config.systemPrompt ||
        "You are a routing classifier. Return only 0, 1, or 2."
    },
    {
      role: "user",
      content: "Return only 0, 1, or 2. Input:\nWarmup."
    }
  ];

  logger?.info?.(
    { model: config.model, baseUrl: config.baseUrl, timeoutMs: warmupTimeout },
    "classifier warmup started"
  );

  try {
    await runClassifier(messages, warmupConfig, false);
    logger?.info?.("classifier warmup completed");
  } catch (err) {
    logger?.warn?.({ err }, "classifier warmup failed");
  }
}

async function attemptClassification(messages, config) {
  const preferStream = Boolean(config.forceStream);
  const primaryDecision = await runClassifier(messages, config, preferStream);
  if (primaryDecision !== null && primaryDecision !== undefined) {
    return primaryDecision;
  }

  if (!preferStream) {
    const fallbackDecision = await runClassifier(messages, config, true);
    if (fallbackDecision === null || fallbackDecision === undefined) {
      throw new Error("classifier returned no decision");
    }
    return fallbackDecision;
  }

  const fallbackDecision = await runClassifier(messages, config, false);
  if (fallbackDecision === null || fallbackDecision === undefined) {
    throw new Error("classifier returned no decision");
  }
  return fallbackDecision;
}

function isAbortError(err) {
  if (!err) return false;
  if (err.name === "AbortError") return true;
  if (err.code === 20) return true;
  const message = String(err.message || "");
  return message.toLowerCase().includes("aborted");
}

function isModelLoadingError(err) {
  if (!err) return false;
  if (err.code === "MODEL_LOADING") return true;
  return isModelLoadingMessage(err.body || err.message || "");
}

function isModelLoadingMessage(text) {
  return String(text).toLowerCase().includes("loading model");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildHeaders(apiKey) {
  const headers = {
    "content-type": "application/json"
  };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

async function readDecisionFromSse(res, controller) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") {
        return null;
      }
      try {
        const json = JSON.parse(data);
        const text =
          json?.choices?.[0]?.delta?.content ??
          json?.choices?.[0]?.text ??
          "";
        const decision = extractDecision(text);
        if (decision !== null) {
          controller.abort();
          return decision;
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

async function runClassifier(messages, config, stream) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const body = {
      model: config.model,
      messages,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      stream
    };

    if (config.logitBias) {
      body.logit_bias = config.logitBias;
    }

    const res = await fetch(resolveChatUrl(config.baseUrl), {
      method: "POST",
      headers: buildHeaders(config.apiKey),
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!res.ok) {
      const text = await safeReadText(res);
      if (isModelLoadingMessage(text)) {
        const error = new Error(`classifier model loading: ${res.status} ${text}`);
        error.code = "MODEL_LOADING";
        error.status = res.status;
        error.body = text;
        throw error;
      }
      throw new Error(`classifier error: ${res.status} ${text}`);
    }

    if (stream) {
      return await readDecisionFromSse(res, controller);
    }

    const json = await res.json();
    const text =
      json?.choices?.[0]?.message?.content ??
      json?.choices?.[0]?.text ??
      "";
    return extractDecision(text);
  } finally {
    clearTimeout(timeout);
  }
}
