const DEFAULT_TIMEOUT_MS = 4000;

export async function fetchModelList({ provider, baseUrl, apiKey, headers, timeoutMs }) {
  const resolved = provider || "openai_compatible";
  switch (resolved) {
    case "openai":
    case "openai_compatible":
    case "xrouter":
    case "mistral":
    case "groq":
    case "together":
    case "perplexity":
      return await fetchOpenAiStyleModels({ baseUrl, apiKey, headers, timeoutMs });
    case "anthropic":
      return await fetchAnthropicModels({ baseUrl, apiKey, headers, timeoutMs });
    case "gemini":
      return await fetchGeminiModels({ baseUrl, apiKey, headers, timeoutMs });
    case "cohere":
      return await fetchCohereModels({ baseUrl, apiKey, headers, timeoutMs });
    case "azure_openai":
      return null;
    default:
      return null;
  }
}

async function fetchOpenAiStyleModels({ baseUrl, apiKey, headers, timeoutMs }) {
  if (!baseUrl) return null;
  const url = buildOpenAiModelsUrl(baseUrl);
  const res = await safeFetch(url, {
    method: "GET",
    headers: buildBearerHeaders(apiKey, headers)
  }, timeoutMs);
  if (!res || !res.ok) return null;
  const json = await safeJson(res);
  const data = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : null;
  if (!data) return null;
  return data
    .map(item => item?.id || item?.name)
    .filter(Boolean);
}

async function fetchAnthropicModels({ baseUrl, apiKey, headers, timeoutMs }) {
  const root = (baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  const url = `${root}/v1/models`;
  const res = await safeFetch(url, {
    method: "GET",
    headers: {
      ...buildBearerHeaders(null, headers),
      "x-api-key": apiKey || "",
      "anthropic-version": headers?.["anthropic-version"] || headers?.["Anthropic-Version"] || "2023-06-01"
    }
  }, timeoutMs);
  if (!res || !res.ok) return null;
  const json = await safeJson(res);
  const data = Array.isArray(json?.data) ? json.data : null;
  if (!data) return null;
  return data.map(item => item?.id).filter(Boolean);
}

async function fetchGeminiModels({ baseUrl, apiKey, headers, timeoutMs }) {
  const root = (baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const url = new URL(`${root}/models`);
  if (apiKey) url.searchParams.set("key", apiKey);
  const res = await safeFetch(url.toString(), {
    method: "GET",
    headers: {
      ...buildBearerHeaders(null, headers),
      "x-goog-api-key": apiKey || ""
    }
  }, timeoutMs);
  if (!res || !res.ok) return null;
  const json = await safeJson(res);
  const models = Array.isArray(json?.models) ? json.models : null;
  if (!models) return null;
  return models
    .map(item => (typeof item?.name === "string" ? item.name.replace(/^models\//, "") : null))
    .filter(Boolean);
}

async function fetchCohereModels({ baseUrl, apiKey, headers, timeoutMs }) {
  const root = (baseUrl || "https://api.cohere.com").replace(/\/+$/, "");
  const url = `${root}/v1/models`;
  const res = await safeFetch(url, {
    method: "GET",
    headers: buildBearerHeaders(apiKey, headers)
  }, timeoutMs);
  if (!res || !res.ok) return null;
  const json = await safeJson(res);
  const models = Array.isArray(json?.models) ? json.models : null;
  if (!models) return null;
  return models
    .map(item => item?.name || item?.id)
    .filter(Boolean);
}

function buildOpenAiModelsUrl(baseUrl) {
  const url = new URL(baseUrl.replace(/\/+$/, ""));
  let path = url.pathname.replace(/\/+$/, "");
  if (path === "" || path === "/") {
    path = "/v1";
  }
  if (path.endsWith("/models")) {
    url.pathname = path;
    return url.toString();
  }
  if (!path.endsWith("/v1") && !path.endsWith("/openai/v1")) {
    path = `${path}/v1`;
  }
  url.pathname = `${path}/models`;
  return url.toString();
}

function buildBearerHeaders(apiKey, extra) {
  const headers = {
    "content-type": "application/json"
  };
  if (apiKey) {
    headers.authorization = apiKey.startsWith("Bearer ") ? apiKey : `Bearer ${apiKey}`;
  }
  if (extra && typeof extra === "object") {
    Object.assign(headers, extra);
  }
  return headers;
}

async function safeFetch(url, init, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
