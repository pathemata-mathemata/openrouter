import crypto from "node:crypto";

export function hashPayload(payload) {
  const input = JSON.stringify({
    messages: payload.messages || [],
    tools: payload.tools || null,
    tool_choice: payload.tool_choice || null,
    response_format: payload.response_format || null
  });
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function extractDecision(text) {
  if (!text) return null;
  const match = String(text).match(/[0-2]/);
  if (!match) return null;
  return Number(match[0]);
}

export function coerceContent(content) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

export function buildClassifierInput(payload, strategy, maxChars = 8000) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  if (strategy === "full_messages") {
    const full = JSON.stringify(messages.map(m => ({ role: m.role, content: m.content })));
    return truncate(full, maxChars);
  }

  const lastUser = [...messages].reverse().find(m => m.role === "user");
  if (lastUser) {
    return truncate(coerceContent(lastUser.content), maxChars);
  }

  const fallback = JSON.stringify(messages.map(m => ({ role: m.role, content: m.content })));
  return truncate(fallback, maxChars);
}

export function truncate(text, maxChars) {
  if (!text || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[TRUNCATED]`;
}

export function nowMs() {
  return Date.now();
}
