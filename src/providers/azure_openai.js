import { nowMs } from "../utils.js";

export async function proxyAzureOpenAi({
  payload,
  upstream,
  reply,
  logger,
  config,
  decision,
  route,
  start
}) {
  const deployment = upstream.deployment || upstream.model || payload.model;
  if (!deployment) {
    reply.code(400).send({ error: "missing_deployment" });
    return reply;
  }

  const apiVersion =
    upstream.apiVersion || config?.azureApiVersion || "2024-02-01";

  const url = buildAzureUrl(upstream.baseUrl, deployment, apiVersion);
  const body = { ...payload };
  delete body.model;

  const headers = {
    "content-type": "application/json",
    "api-key": upstream.apiKey || ""
  };
  if (upstream.apiKey && upstream.apiKey.startsWith("Bearer ")) {
    delete headers["api-key"];
    headers.authorization = upstream.apiKey;
  }
  if (upstream.headers && typeof upstream.headers === "object") {
    Object.assign(headers, upstream.headers);
  }

  const controller = new AbortController();
  const upstreamTimeout = setTimeout(() => controller.abort(), upstream.timeoutMs);

  try {
    const upstreamRes = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
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
        for await (const chunk of upstreamRes.body) {
          reply.raw.write(chunk);
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

function buildAzureUrl(baseUrl, deployment, apiVersion) {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.includes("/openai/deployments/")) {
    const url = new URL(trimmed);
    if (!url.pathname.endsWith("/chat/completions")) {
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`;
    }
    url.searchParams.set("api-version", apiVersion);
    return url.toString();
  }
  return `${trimmed}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
}
