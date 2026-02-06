import { nowMs } from "../utils.js";

export function extractText(content) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (!part) return "";
        if (typeof part === "string") return part;
        if (typeof part.text === "string") return part.text;
        if (typeof part.content === "string") return part.content;
        return "";
      })
      .join("");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

export function splitSystemMessages(messages) {
  const system = [];
  const rest = [];
  for (const message of messages || []) {
    if (message?.role === "system") {
      system.push(extractText(message.content));
    } else {
      rest.push(message);
    }
  }
  return { system: system.filter(Boolean).join("\n"), rest };
}

export function openAiResponse({ text, model, finishReason = "stop", usage }) {
  return {
    id: `chatcmpl_${Math.random().toString(36).slice(2)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || "unknown",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text ?? ""
        },
        finish_reason: finishReason
      }
    ],
    usage: usage || undefined
  };
}

export function initOpenAiStream(reply, upstreamStatus, headers = {}) {
  reply.hijack();
  reply.raw.statusCode = upstreamStatus || 200;
  reply.raw.setHeader("content-type", "text/event-stream");
  reply.raw.setHeader("cache-control", "no-cache");
  reply.raw.setHeader("connection", "keep-alive");
  for (const [key, value] of Object.entries(headers)) {
    reply.raw.setHeader(key, value);
  }
}

export function writeOpenAiChunk(reply, text, model) {
  const payload = {
    id: `chatcmpl_${Math.random().toString(36).slice(2)}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model || "unknown",
    choices: [
      {
        index: 0,
        delta: {
          content: text
        },
        finish_reason: null
      }
    ]
  };
  reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function writeOpenAiDone(reply) {
  reply.raw.write("data: [DONE]\n\n");
  reply.raw.end();
}

export function logProxyResult({ logger, route, start, stream }) {
  if (!logger) return;
  logger.info({ route, ms: nowMs() - start }, stream ? "routed stream response" : "routed response");
}
