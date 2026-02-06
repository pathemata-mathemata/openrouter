import { readSse } from "./sse.js";
import {
  extractText,
  splitSystemMessages,
  openAiResponse,
  initOpenAiStream,
  writeOpenAiChunk,
  writeOpenAiDone,
  logProxyResult
} from "./helpers.js";
import { recordUsage } from "../token_tracker.js";

export async function proxyGemini({
  payload,
  upstream,
  reply,
  logger,
  config,
  decision,
  route,
  start
}) {
  const baseUrl = (upstream.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const model = upstream.model || payload.model;
  if (!model) {
    reply.code(400).send({ error: "missing_model" });
    return reply;
  }

  const { system, rest } = splitSystemMessages(payload.messages || []);
  const contents = rest.map(message => {
    const role = message.role === "assistant" ? "model" : "user";
    return {
      role,
      parts: [{ text: extractText(message.content) }]
    };
  });

  const generationConfig = {};
  if (typeof payload.temperature === "number") generationConfig.temperature = payload.temperature;
  if (typeof payload.top_p === "number") generationConfig.topP = payload.top_p;
  if (payload.max_tokens || payload.max_completion_tokens) {
    generationConfig.maxOutputTokens = payload.max_tokens ?? payload.max_completion_tokens;
  }
  if (payload.stop) {
    generationConfig.stopSequences = Array.isArray(payload.stop) ? payload.stop : [payload.stop];
  }

  const body = {
    contents
  };
  if (system) {
    body.systemInstruction = {
      role: "system",
      parts: [{ text: system }]
    };
  }
  if (Object.keys(generationConfig).length) {
    body.generationConfig = generationConfig;
  }

  const isStream = Boolean(payload.stream);
  const url = buildGeminiUrl(baseUrl, model, isStream, upstream.apiKey);

  const headers = {
    "content-type": "application/json"
  };
  if (upstream.apiKey) {
    headers["x-goog-api-key"] = upstream.apiKey;
  }
  if (upstream.headers && typeof upstream.headers === "object") {
    Object.assign(headers, upstream.headers);
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  reply.header(config.decisionHeader, String(decision));
  reply.header(config.upstreamHeader, upstream.name || route);

  if (!res.ok) {
    const text = await res.text();
    logger.error({ route, status: res.status, body: text }, "upstream error response");
    reply.code(res.status).send({ error: "upstream_error", details: text });
    return reply;
  }

  if (isStream) {
    initOpenAiStream(reply, res.status);
    let usageRecorded = false;
    for await (const data of readSse(res)) {
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (!usageRecorded && json?.usageMetadata) {
        recordUsage({ route, upstream, usage: json.usageMetadata });
        usageRecorded = true;
      }
      const text = extractGeminiText(json);
      if (text) {
        writeOpenAiChunk(reply, text, model);
      }
    }
    writeOpenAiDone(reply);
    logProxyResult({ logger, route, start, stream: true });
    return;
  }

  const json = await res.json();
  if (json?.usageMetadata) {
    recordUsage({ route, upstream, usage: json.usageMetadata });
  }
  const text = extractGeminiText(json);
  reply.code(res.status).send(openAiResponse({ text, model }));
  logProxyResult({ logger, route, start, stream: false });
  return reply;
}

function buildGeminiUrl(baseUrl, model, stream, apiKey) {
  const suffix = stream ? ":streamGenerateContent" : ":generateContent";
  const url = new URL(`${baseUrl}/models/${encodeURIComponent(model)}${suffix}`);
  if (stream) {
    url.searchParams.set("alt", "sse");
  }
  if (apiKey && !url.searchParams.has("key")) {
    url.searchParams.set("key", apiKey);
  }
  return url.toString();
}

function extractGeminiText(json) {
  const candidates = json?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return "";
  const parts = candidates[0]?.content?.parts;
  if (Array.isArray(parts)) {
    return parts.map(part => part.text || "").join("");
  }
  return candidates[0]?.content?.text || "";
}
