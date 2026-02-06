import { nowMs } from "../utils.js";
import { recordUsage } from "../token_tracker.js";

export async function proxyOpenAiCompatible({
  payload,
  upstream,
  reply,
  logger,
  config,
  decision,
  route,
  start
}) {
  const upstreamModel = upstream.model || payload.model;
  const upstreamPayload = { ...payload, model: upstreamModel };

  const controller = new AbortController();
  const upstreamTimeout = setTimeout(() => controller.abort(), upstream.timeoutMs);

  try {
    const upstreamRes = await fetch(buildUpstreamUrl(upstream.baseUrl), {
      method: "POST",
      headers: buildUpstreamHeaders(upstream),
      body: JSON.stringify(upstreamPayload),
      signal: controller.signal
    });

    reply.header(config.decisionHeader, String(decision));
    reply.header(config.upstreamHeader, upstream.name || route);

  if (payload.stream) {
    reply.hijack();
    reply.raw.statusCode = upstreamRes.status;
    for (const [key, value] of upstreamRes.headers) {
      if (key.toLowerCase() === "content-length") continue;
      reply.raw.setHeader(key, value);
    }

    if (upstreamRes.body) {
      const decoder = new TextDecoder();
      let buffer = "";
      let usageRecorded = false;
      for await (const chunk of upstreamRes.body) {
        reply.raw.write(chunk);
        if (!usageRecorded) {
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
              const json = JSON.parse(data);
              if (json?.usage) {
                recordUsage({ route, upstream, usage: json.usage });
                usageRecorded = true;
                break;
              }
            } catch {
              continue;
            }
          }
        }
      }
    }
    reply.raw.end();
    logger.info({ route, ms: nowMs() - start }, "routed stream response");
    return;
    }

    const contentType = upstreamRes.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const json = await upstreamRes.json();
      if (!upstreamRes.ok) {
        logger.error(
          { route, status: upstreamRes.status, body: json },
          "upstream error response"
        );
      }
      if (json?.usage) {
        recordUsage({ route, upstream, usage: json.usage });
      }
      reply.code(upstreamRes.status).send(json);
    } else {
      const text = await upstreamRes.text();
      if (!upstreamRes.ok) {
        logger.error(
          { route, status: upstreamRes.status, body: text },
          "upstream error response"
        );
      }
      reply.code(upstreamRes.status).send(text);
    }

    logger.info({ route, ms: nowMs() - start }, "routed response");
    return reply;
  } catch (err) {
    logger.error({ err }, "upstream error");
    reply.code(502).send({ error: "upstream_error" });
    return reply;
  } finally {
    clearTimeout(upstreamTimeout);
  }
}

function buildUpstreamHeaders(upstream) {
  const headers = {
    "content-type": "application/json"
  };
  if (upstream?.apiKey) {
    headers.authorization = `Bearer ${upstream.apiKey}`;
  }
  if (upstream?.headers && typeof upstream.headers === "object") {
    Object.assign(headers, upstream.headers);
  }
  return headers;
}

function buildUpstreamUrl(baseUrl) {
  const url = new URL(baseUrl.replace(/\/+$/, ""));
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
