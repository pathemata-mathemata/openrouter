import { proxyOpenAiCompatible } from "./openai_compatible.js";
import { proxyAnthropic } from "./anthropic.js";
import { proxyGemini } from "./gemini.js";
import { proxyCohere } from "./cohere.js";
import { proxyAzureOpenAi } from "./azure_openai.js";

const adapters = new Map([
  ["openai_compatible", proxyOpenAiCompatible],
  ["openrouter", proxyOpenAiCompatible],
  ["openai", proxyOpenAiCompatible],
  ["mistral", proxyOpenAiCompatible],
  ["groq", proxyOpenAiCompatible],
  ["together", proxyOpenAiCompatible],
  ["perplexity", proxyOpenAiCompatible],
  ["anthropic", proxyAnthropic],
  ["gemini", proxyGemini],
  ["cohere", proxyCohere],
  ["azure_openai", proxyAzureOpenAi]
]);

export function resolveProvider(upstream) {
  const configured = upstream?.provider;
  if (configured && configured !== "auto") return configured;
  const detected = detectProvider(upstream?.baseUrl, upstream?.apiKey);
  return detected || "openai_compatible";
}

export function getProviderAdapter(upstream) {
  const provider = resolveProvider(upstream);
  const adapter = adapters.get(provider || "openai_compatible");
  if (!adapter) {
    return async ({ reply }) => {
      reply.code(501).send({
        error: "provider_not_supported",
        provider,
        message: "Provider adapter not implemented yet"
      });
    };
  }
  return adapter;
}

export function detectProvider(baseUrl, apiKey) {
  const host = safeHost(baseUrl);
  if (host) {
    if (host.includes("anthropic.com")) return "anthropic";
    if (host.includes("generativelanguage.googleapis.com")) return "gemini";
    if (host.includes("api.cohere.ai")) return "cohere";
    if (host.includes("openai.azure.com")) return "azure_openai";
    if (host.includes("api.mistral.ai")) return "mistral";
    if (host.includes("api.groq.com")) return "groq";
    if (host.includes("api.together.xyz")) return "together";
    if (host.includes("api.perplexity.ai")) return "perplexity";
    if (host.includes("openrouter.ai")) return "openrouter";
    if (host.includes("api.openai.com")) return "openai";
  }

  if (apiKey) {
    if (apiKey.startsWith("sk-ant-")) return "anthropic";
    if (apiKey.startsWith("AIza")) return "gemini";
    if (apiKey.toLowerCase().startsWith("cohere")) return "cohere";
  }

  return null;
}

function safeHost(baseUrl) {
  if (!baseUrl) return "";
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "";
  }
}
