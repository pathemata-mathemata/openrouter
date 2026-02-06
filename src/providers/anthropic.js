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

export async function proxyAnthropic({
  payload,
  upstream,
  reply,
  logger,
  config,
  decision,
  route,
  start
}) {
  const baseUrl = (upstream.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  const url = `${baseUrl}/v1/messages`;
  const { system, rest } = splitSystemMessages(payload.messages || []);

  const messages = rest.map(message => {
    const role = message.role === "assistant" ? "assistant" : "user";
    const content = extractText(message.content);
    return { role, content };
  });

  const maxTokens =
    payload.max_tokens ??
    payload.max_completion_tokens ??
    Number.parseInt(process.env.ANTHROPIC_MAX_TOKENS || "1024", 10);

  const body = {
    model: upstream.model || payload.model,
    max_tokens: maxTokens,
    messages,
    stream: Boolean(payload.stream)
  };

  if (system) body.system = system;
  if (typeof payload.temperature === "number") body.temperature = payload.temperature;
  if (typeof payload.top_p === "number") body.top_p = payload.top_p;
  if (payload.stop) {
    body.stop_sequences = Array.isArray(payload.stop) ? payload.stop : [payload.stop];
  }

  const headers = {
    "content-type": "application/json",
    "anthropic-version": config?.anthropicVersion || "2023-06-01"
  };
  if (upstream.apiKey) {
    headers["x-api-key"] = upstream.apiKey;
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

      if (!usageRecorded && json?.type === "message_start" && json?.message?.usage) {
        recordUsage({ route, upstream, usage: json.message.usage });
        usageRecorded = true;
      }

      if (json.type === "content_block_delta" && json.delta?.text) {
        writeOpenAiChunk(reply, json.delta.text, body.model);
      }
    }
    writeOpenAiDone(reply);
    logProxyResult({ logger, route, start, stream: true });
    return;
  }

  const json = await res.json();
  if (json?.usage) {
    recordUsage({ route, upstream, usage: json.usage });
  }
  const text = Array.isArray(json.content)
    ? json.content.map(part => part.text || "").join("")
    : "";

  reply.code(res.status).send(openAiResponse({ text, model: body.model }));
  logProxyResult({ logger, route, start, stream: false });
  return reply;
}
