import { readSse } from "./sse.js";
import {
  extractText,
  openAiResponse,
  initOpenAiStream,
  writeOpenAiChunk,
  writeOpenAiDone,
  logProxyResult
} from "./helpers.js";
import { recordUsage } from "../token_tracker.js";

export async function proxyCohere({
  payload,
  upstream,
  reply,
  logger,
  config,
  decision,
  route,
  start
}) {
  const baseUrl = (upstream.baseUrl || "https://api.cohere.com").replace(/\/+$/, "");
  const url = buildCohereUrl(baseUrl);

  const messages = (payload.messages || []).map(message => {
    const role = normalizeRole(message.role);
    return {
      role,
      content: extractText(message.content)
    };
  });

  const body = {
    model: upstream.model || payload.model,
    messages,
    stream: Boolean(payload.stream)
  };

  if (typeof payload.temperature === "number") body.temperature = payload.temperature;
  if (payload.max_tokens || payload.max_completion_tokens) {
    body.max_tokens = payload.max_tokens ?? payload.max_completion_tokens;
  }

  const headers = {
    "content-type": "application/json"
  };
  if (upstream.apiKey) {
    headers.authorization = `Bearer ${upstream.apiKey}`;
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

  if (payload.stream) {
    initOpenAiStream(reply, res.status);
    let usageRecorded = false;
    for await (const data of readSse(res)) {
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (!usageRecorded) {
        const usage = json?.response?.meta?.tokens || json?.meta?.tokens;
        if (usage) {
          recordUsage({ route, upstream, usage });
          usageRecorded = true;
        }
      }
      const text = extractCohereStreamText(json);
      if (text) {
        writeOpenAiChunk(reply, text, body.model);
      }
    }
    writeOpenAiDone(reply);
    logProxyResult({ logger, route, start, stream: true });
    return;
  }

  const json = await res.json();
  const usage = json?.meta?.tokens || json?.response?.meta?.tokens;
  if (usage) {
    recordUsage({ route, upstream, usage });
  }
  const text = extractCohereText(json);
  reply.code(res.status).send(openAiResponse({ text, model: body.model }));
  logProxyResult({ logger, route, start, stream: false });
  return reply;
}

function buildCohereUrl(baseUrl) {
  if (baseUrl.endsWith("/v2/chat") || baseUrl.endsWith("/chat")) {
    return baseUrl;
  }
  return `${baseUrl}/v2/chat`;
}

function normalizeRole(role) {
  if (role === "assistant") return "assistant";
  if (role === "system") return "system";
  if (role === "tool" || role === "function") return "tool";
  return "user";
}

function extractCohereText(json) {
  const message = json?.message;
  if (message?.content && Array.isArray(message.content)) {
    return message.content.map(part => part.text || "").join("");
  }
  if (typeof json?.text === "string") {
    return json.text;
  }
  return "";
}

function extractCohereStreamText(json) {
  if (json?.type === "content-delta") {
    return json?.delta?.message?.content?.text || "";
  }
  if (json?.type === "message-end") {
    return "";
  }
  return "";
}
