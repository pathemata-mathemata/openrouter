import crypto from "node:crypto";

export function coerceText(content) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (!part) return "";
        if (typeof part === "string") return part;
        if (part.type === "text" && part.text) return part.text;
        if (part.text) return part.text;
        if (part.input_text) return part.input_text;
        if (part.content) return coerceText(part.content);
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

export function splitMessages(messages = []) {
  const system = [];
  const conversation = [];
  for (const message of messages) {
    if (!message) continue;
    const role = message.role || "user";
    const text = coerceText(message.content);
    if (role === "system") {
      if (text) system.push(text);
    } else {
      conversation.push({ role, text });
    }
  }
  return {
    system: system.join("\n\n"),
    conversation
  };
}

export function openAiResponse({ model, text, usage }) {
  const created = Math.floor(Date.now() / 1000);
  return {
    id: `chatcmpl_${randomId()}`,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text
        },
        finish_reason: "stop"
      }
    ],
    ...(usage ? { usage } : {})
  };
}

export function sendOpenAiStream({ reply, model, text }) {
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl_${randomId()}`;

  reply.hijack();
  reply.raw.statusCode = 200;
  reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
  reply.raw.setHeader("cache-control", "no-cache, no-transform");
  reply.raw.setHeader("connection", "keep-alive");

  const first = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: { content: text },
        finish_reason: null
      }
    ]
  };

  reply.raw.write(`data: ${JSON.stringify(first)}\n\n`);

  const last = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop"
      }
    ]
  };

  reply.raw.write(`data: ${JSON.stringify(last)}\n\n`);
  reply.raw.write("data: [DONE]\n\n");
  reply.raw.end();
}

export function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, "");
}

export function randomId() {
  return crypto.randomBytes(8).toString("hex");
}
