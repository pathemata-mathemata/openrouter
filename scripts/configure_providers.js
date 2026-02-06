import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { detectHardware } from "./check_hw.js";
import { detectProvider } from "../src/providers/index.js";
import { fetchModelList } from "./provider_model_fetch.js";

const rl = readline.createInterface({ input, output });
const execFileAsync = promisify(execFile);

function normalizeEmpty(value) {
  const trimmed = String(value || "").trim();
  return trimmed === "" ? null : trimmed;
}

async function ask(question, fallback = "") {
  const suffix = fallback ? ` (${fallback})` : "";
  const answer = await rl.question(`${question}${suffix}: `);
  return normalizeEmpty(answer) ?? fallback;
}

async function askRequired(question) {
  while (true) {
    const answer = await rl.question(`${question}: `);
    const normalized = normalizeEmpty(answer);
    if (normalized) return normalized;
  }
}

async function askOptional(question) {
  const answer = await rl.question(`${question} (leave blank to skip): `);
  return normalizeEmpty(answer);
}

async function main() {
  output.write("\nOpenRouter provider setup\n");
  output.write("This will scan hardware, write ./upstreams.json, and optionally update .env.\n\n");

  const hardware = await detectHardware();
  const memLine = hardware.totalMemGb ? `${hardware.totalMemGb} GB RAM` : "RAM unknown";
  const vramLine = hardware.vramGb ? `${hardware.vramGb} GB VRAM` : "VRAM unknown";
  output.write(
    `Detected: ${hardware.platform} ${hardware.arch}, ${memLine}, ${vramLine}. Recommended engine: ${hardware.engine} (${hardware.reason}).\n\n`
  );

  const hasGpuVram = typeof hardware.vramGb === "number" && hardware.vramGb >= 6;
  const hasRam = typeof hardware.totalMemGb === "number" ? hardware.totalMemGb >= 8 : true;
  const canLocal = hasGpuVram || hasRam;
  const quickDefault = canLocal ? "yes" : "no";
  const quickStartAnswer = await ask("Quick start mode (local classifier + cheap route)", quickDefault);
  const quickStart = canLocal && quickStartAnswer.toLowerCase().startsWith("y");
  if (!canLocal && quickStartAnswer.toLowerCase().startsWith("y")) {
    output.write("Quick start requires a local-capable machine. Falling back to full setup.\n\n");
  }

  let enableLocal = false;
  if (quickStart) {
    enableLocal = true;
  } else {
    const localDefault = canLocal ? "yes" : "no";
    const enableLocalAnswer = await ask("Enable local classifier", localDefault);
    enableLocal = enableLocalAnswer.toLowerCase().startsWith("y");
  }

  let classifierBaseUrl = null;
  let classifierModel = null;

  if (enableLocal) {
    if (quickStart) {
      classifierBaseUrl = recommendedBaseUrl(hardware.engine);
      classifierModel = await chooseLocalModelQuick(hardware, classifierBaseUrl);
      output.write("Quick start: local classifier configured.\n");
      output.write(`- Base URL: ${classifierBaseUrl}\n`);
      output.write(`- Model: ${classifierModel}\n\n`);
    } else {
      classifierBaseUrl = await ask("Classifier base URL", recommendedBaseUrl(hardware.engine));
      const modelChoice = await chooseLocalModel(hardware, classifierBaseUrl);
      classifierModel = modelChoice;
    }
  } else {
    output.write("Local classifier disabled. Router will use full cloud mode.\n\n");
  }

  if (quickStart && enableLocal) {
    output.write("Quick start: cheap route will use the same local engine/model as classifier.\n\n");
  } else {
    output.write("\nConfigure CHEAP route\n");
  }
  let configureCheap = true;
  if (!enableLocal) {
    const configureCheapDefault = "no";
    const configureCheapAnswer = await ask("Configure cheap route", configureCheapDefault);
    configureCheap = configureCheapAnswer.toLowerCase().startsWith("y");
  }

  let cheapName = null;
  let cheapProvider = null;
  let cheapBaseUrl = null;
  let cheapApiKey = null;
  let cheapModel = null;
  let cheapDeployment = null;
  let cheapApiVersion = null;

  if (configureCheap) {
    if (quickStart && enableLocal) {
      cheapName = "cheap";
      cheapProvider = "openai_compatible";
      cheapBaseUrl = classifierBaseUrl;
      cheapApiKey = null;
      cheapModel = classifierModel;
    } else {
      cheapProvider = await chooseProviderType("cheap");
      cheapName = cheapProvider;
      warnIfUnsupported(cheapProvider);
      let useLocalCheap = false;
      if (enableLocal && (cheapProvider === "auto" || cheapProvider === "openai_compatible")) {
        const useLocalAnswer = await ask("Use local classifier engine for cheap route", "yes");
        useLocalCheap = useLocalAnswer.toLowerCase().startsWith("y");
      }
      const cheapDefaultBaseUrl = useLocalCheap
        ? classifierBaseUrl
        : suggestBaseUrlForProvider(cheapProvider);
      cheapBaseUrl = await resolveBaseUrl("cheap", cheapProvider, cheapDefaultBaseUrl);
      cheapApiKey = await askOptional("Cheap provider API key");
      if (useLocalCheap) {
        cheapModel = classifierModel;
        output.write(
          `Cheap route will use the classifier model (${cheapModel}) to avoid local model swapping.\n`
        );
      } else {
        cheapModel = await chooseCloudModel("cheap", cheapProvider, cheapBaseUrl, cheapApiKey);
      }
      if (cheapProvider === "azure_openai") {
        cheapDeployment = await askOptional("Cheap Azure deployment name");
        cheapApiVersion = await ask("Cheap Azure API version", "2024-10-21");
      }
    }
  }

  output.write("\nConfigure MEDIUM route\n");
  let configureMedium = true;
  if (!enableLocal) {
    const configureMediumAnswer = await ask("Configure medium route", "no");
    configureMedium = configureMediumAnswer.toLowerCase().startsWith("y");
  }

  let mediumName = null;
  let mediumProvider = null;
  let mediumBaseUrl = null;
  let mediumApiKey = null;
  let mediumModel = null;
  let mediumDeployment = null;
  let mediumApiVersion = null;

  if (configureMedium) {
    mediumProvider = await chooseProviderType("medium");
    mediumName = mediumProvider;
    warnIfUnsupported(mediumProvider);
    const mediumDefaultBaseUrl = suggestBaseUrlForProvider(mediumProvider);
    mediumBaseUrl = await resolveBaseUrlNoOverride("medium", mediumProvider, mediumDefaultBaseUrl);
    mediumApiKey = await askOptional("Medium provider API key");
    mediumModel = await chooseCloudModel("medium", mediumProvider, mediumBaseUrl, mediumApiKey);
    if (mediumProvider === "azure_openai") {
      mediumDeployment = await askOptional("Medium Azure deployment name");
      mediumApiVersion = await ask("Medium Azure API version", "2024-10-21");
    }
  }

  output.write("\nConfigure FRONTIER route\n");
  const frontierProvider = await chooseProviderType("frontier");
  const frontierName = frontierProvider;
  warnIfUnsupported(frontierProvider);
  const frontierDefaultBaseUrl = suggestBaseUrlForProvider(frontierProvider);
  const frontierResolvedBaseUrl = await resolveBaseUrlNoOverride(
    "frontier",
    frontierProvider,
    frontierDefaultBaseUrl
  );
  const frontierApiKey = await askOptional("Frontier provider API key");
  const frontierModel = await chooseCloudModel(
    "frontier",
    frontierProvider,
    frontierResolvedBaseUrl,
    frontierApiKey
  );
  let frontierDeployment = null;
  let frontierApiVersion = null;
  if (frontierProvider === "azure_openai") {
    frontierDeployment = await askOptional("Frontier Azure deployment name");
    frontierApiVersion = await ask("Frontier Azure API version", "2024-10-21");
  }

  const upstreams = {
    cheap: configureCheap
      ? finalizeUpstream(
          buildUpstream({
            name: cheapName,
            provider: cheapProvider,
            baseUrl: cheapBaseUrl,
            apiKey: cheapApiKey,
            model: cheapModel,
            deployment: cheapDeployment,
            apiVersion: cheapApiVersion
          })
        )
      : null,
    medium: configureMedium
      ? finalizeUpstream(
          buildUpstream({
            name: mediumName,
            provider: mediumProvider,
            baseUrl: mediumBaseUrl,
            apiKey: mediumApiKey,
            model: mediumModel,
            deployment: mediumDeployment,
            apiVersion: mediumApiVersion
          })
        )
      : null,
    frontier: buildUpstream({
      name: frontierName,
      provider: frontierProvider,
      baseUrl: frontierResolvedBaseUrl,
      apiKey: frontierApiKey,
      model: frontierModel,
      deployment: frontierDeployment,
      apiVersion: frontierApiVersion
    })
  };

  const upstreamsPath = path.resolve(process.cwd(), "upstreams.json");
  fs.writeFileSync(upstreamsPath, `${JSON.stringify(upstreams, null, 2)}\n`, "utf8");
  output.write(`\nWrote ${upstreamsPath}\n`);

  const envPath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const confirm = await ask("Update existing .env with classifier settings?", "no");
    if (confirm.toLowerCase().startsWith("y")) {
      const content = fs.readFileSync(envPath, "utf8");
      const next = updateEnv(content, {
        CLASSIFIER_ENABLED: enableLocal ? "true" : "false",
        CLASSIFIER_BASE_URL: classifierBaseUrl ?? "",
        CLASSIFIER_MODEL: classifierModel ?? "",
        UPSTREAMS_FILE: "./upstreams.json"
      });
      fs.writeFileSync(envPath, next, "utf8");
      output.write(`Updated ${envPath}\n`);
    }
  } else {
    const confirm = await ask("Create .env with classifier settings?", "yes");
    if (confirm.toLowerCase().startsWith("y")) {
      const lines = [
        `CLASSIFIER_ENABLED=${enableLocal ? "true" : "false"}`,
        `CLASSIFIER_BASE_URL=${classifierBaseUrl ?? ""}`,
        `CLASSIFIER_MODEL=${classifierModel ?? ""}`,
        `UPSTREAMS_FILE=./upstreams.json`
      ];
      fs.writeFileSync(envPath, `${lines.join("\n")}\n`, "utf8");
      output.write(`Created ${envPath}\n`);
    }
  }

  output.write("\nDone. You can now run: npm run dev\n\n");
  rl.close();
}

function buildUpstream(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined && value !== "") {
      out[key] = value;
    }
  }
  return out;
}

function finalizeUpstream(upstream) {
  if (!upstream || !upstream.baseUrl) return null;
  return upstream;
}

async function chooseLocalModel(hardware, baseUrl) {
  const ollamaModels = await fetchOllamaModels(hardware, baseUrl);
  if (ollamaModels && ollamaModels.length) {
    return await chooseFromList(`classifier`, ollamaModels);
  }
  if (hardware.engine === "mlx") {
    output.write(
      "Warning: could not reach Ollama or find/download models. Using fallback list.\n"
    );
  }
  const catalog = loadModelCatalog();
  const models = catalog.filter(model => model.engine === hardware.engine);
  if (!models.length) {
    return await ask("Classifier model", "meta-llama/Meta-Llama-3.1-8B-Instruct");
  }

  const scored = models.map(model => ({
    model,
    fits: modelFitsHardware(model, hardware)
  }));

  const recommended = pickRecommended(scored);

  output.write("\nAvailable local models:\n");
  scored.forEach((entry, index) => {
    const tags = [];
    if (entry.model.id === recommended.id) tags.push("recommended");
    if (!entry.fits) tags.push("likely too large");
    if (entry.model.sizeB) tags.push(`${entry.model.sizeB}B`);
    if (entry.model.quantization) tags.push(entry.model.quantization);
    const tagString = tags.length ? ` [${tags.join(", ")}]` : "";
    output.write(`${index + 1}. ${entry.model.id}${tagString}\n`);
  });
  output.write("0. Enter a custom model id\n\n");

  const recommendedIndex = scored.findIndex(entry => entry.model.id === recommended.id);
  const choice = await ask("Select classifier model number", String(recommendedIndex + 1));
  const trimmed = String(choice).trim();
  if (trimmed === "0") {
    return await ask("Enter custom model id");
  }

  const asNumber = Number.parseInt(trimmed, 10);
  if (!Number.isNaN(asNumber) && asNumber >= 1 && asNumber <= scored.length) {
    return scored[asNumber - 1].model.id;
  }

  if (trimmed && Number.isNaN(Number(trimmed))) {
    return trimmed;
  }

  return recommended.id;
}

async function chooseLocalModelQuick(hardware, baseUrl) {
  const ollamaModels = await fetchOllamaModels(hardware, baseUrl, { autoPull: true });
  if (ollamaModels && ollamaModels.length) {
    return pickOllamaDefault(ollamaModels);
  }
  if (hardware.engine === "mlx") {
    output.write(
      "Warning: could not reach Ollama or find/download models. Using fallback list.\n"
    );
  }
  const catalog = loadModelCatalog();
  const models = catalog.filter(model => model.engine === hardware.engine);
  if (!models.length) {
    return await askRequired("Enter classifier model id");
  }
  const scored = models.map(model => ({
    model,
    fits: modelFitsHardware(model, hardware)
  }));
  const recommended = pickRecommended(scored);
  return recommended.id;
}

async function chooseLocalModelForRoute(hardware, baseUrl, label) {
  const ollamaModels = await fetchOllamaModels(hardware, baseUrl);
  if (ollamaModels && ollamaModels.length) {
    return await chooseFromList(label, ollamaModels);
  }
  if (hardware.engine === "mlx") {
    output.write(
      "Warning: could not reach Ollama or find/download models. Using fallback list.\n"
    );
  }
  const catalog = loadModelCatalog();
  const models = catalog.filter(model => model.engine === hardware.engine);
  if (!models.length) {
    return await askRequired(`Enter ${label} model id`);
  }

  const scored = models.map(model => ({
    model,
    fits: modelFitsHardware(model, hardware)
  }));

  const recommended = pickRecommended(scored);

  output.write(`\nAvailable local models for ${label}:\n`);
  scored.forEach((entry, index) => {
    const tags = [];
    if (entry.model.id === recommended.id) tags.push("recommended");
    if (!entry.fits) tags.push("likely too large");
    if (entry.model.sizeB) tags.push(`${entry.model.sizeB}B`);
    if (entry.model.quantization) tags.push(entry.model.quantization);
    const tagString = tags.length ? ` [${tags.join(", ")}]` : "";
    output.write(`${index + 1}. ${entry.model.id}${tagString}\n`);
  });
  output.write("0. Enter a custom model id\n\n");

  while (true) {
    const choice = await askRequired(`Select ${label} model number`);
    const trimmed = String(choice).trim();
    if (trimmed === "0") {
      return await askRequired(`Enter ${label} model id`);
    }

    const asNumber = Number.parseInt(trimmed, 10);
    if (!Number.isNaN(asNumber) && asNumber >= 1 && asNumber <= scored.length) {
      return scored[asNumber - 1].model.id;
    }

    if (trimmed && Number.isNaN(Number(trimmed))) {
      return trimmed;
    }
  }
}

function modelFitsHardware(model, hardware) {
  if (typeof model.minRamGb === "number" && typeof hardware.totalMemGb === "number") {
    if (hardware.totalMemGb < model.minRamGb) return false;
  }
  if (typeof model.minVramGb === "number" && typeof hardware.vramGb === "number") {
    if (hardware.vramGb < model.minVramGb) return false;
  }
  return true;
}

function pickRecommended(scored) {
  const fits = scored.filter(entry => entry.fits);
  if (!fits.length) {
    return scored[0].model;
  }
  fits.sort((a, b) => (b.model.sizeB || 0) - (a.model.sizeB || 0));
  return fits[0].model;
}

function loadModelCatalog() {
  const catalogUrl = new URL("./model_catalog.json", import.meta.url);
  const raw = fs.readFileSync(catalogUrl, "utf8");
  const json = JSON.parse(raw);
  if (!Array.isArray(json)) {
    throw new Error("model_catalog.json must be an array");
  }
  return json;
}

async function fetchOllamaModels(hardware, baseUrl, options = {}) {
  const { autoPull = false } = options;
  if (hardware.engine !== "mlx") return null;
  const url = (baseUrl || "http://localhost:11434").replace(/\/+$/, "");
  const tagsUrl = `${url}/api/tags`;
  const models = await safeFetchJson(tagsUrl, 1500);
  if (models && Array.isArray(models.models)) {
    const names = models.models.map(item => item?.name).filter(Boolean);
    if (names.length) return names;
  }
  const openAiUrl = `${url}/v1/models`;
  const openAiModels = await safeFetchJson(openAiUrl, 1500);
  if (openAiModels && Array.isArray(openAiModels.data)) {
    const names = openAiModels.data.map(item => item?.id).filter(Boolean);
    if (names.length) return names;
  }
  const ollamaCmd = await resolveOllamaCommand();
  if (!ollamaCmd) {
    if (autoPull) {
      output.write(
        "Ollama CLI not found. Install Ollama to auto-download a local model.\n"
      );
    }
    return null;
  }
  const suggested = suggestOllamaModel(hardware);
  let shouldPull = autoPull;
  if (autoPull) {
    output.write(`No local Ollama models found. Auto-downloading ${suggested}...\n`);
  } else {
    const answer = await ask(
      `No local Ollama models found. Download ${suggested} now`,
      "yes"
    );
    shouldPull = answer.toLowerCase().startsWith("y");
  }
  if (!shouldPull) return null;
  const pulled = await pullOllamaModel(ollamaCmd, suggested);
  if (!pulled) return null;
  const retry = await safeFetchJson(tagsUrl, 1500);
  if (retry && Array.isArray(retry.models)) {
    const names = retry.models.map(item => item?.name).filter(Boolean);
    if (names.length) return names;
  }
  return null;
}

function pickOllamaDefault(models) {
  const candidates = models.filter(model => !isLikelyVisionModel(model));
  const pool = candidates.length ? candidates : models;
  const preferred = [
    "llama3.1",
    "llama3.2",
    "llama3",
    "gemma2",
    "mistral"
  ];
  for (const prefix of preferred) {
    const match = pool.find(name => name.startsWith(prefix));
    if (match) return match;
  }
  return pool[0];
}

function isLikelyVisionModel(name) {
  return /(^|[-_:])(vision|vl|multimodal|image|mllama|llava|clip)([-_:]|$)/i.test(
    name
  );
}

async function chooseFromList(label, items) {
  output.write(`\nAvailable local models for ${label}:\n`);
  items.forEach((item, index) => {
    output.write(`${index + 1}. ${item}\n`);
  });
  output.write("0. Enter a custom model id\n\n");
  while (true) {
    const choice = await askRequired(`Select ${label} model number`);
    const trimmed = String(choice).trim();
    if (trimmed === "0") {
      return await askRequired(`Enter ${label} model id`);
    }
    const asNumber = Number.parseInt(trimmed, 10);
    if (!Number.isNaN(asNumber) && asNumber >= 1 && asNumber <= items.length) {
      return items[asNumber - 1];
    }
    if (trimmed && Number.isNaN(Number(trimmed))) {
      return trimmed;
    }
  }
}

async function safeFetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function hasCommand(cmd) {
  try {
    await execFileAsync(cmd, ["--version"], { timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

function suggestOllamaModel(hardware) {
  const mem = typeof hardware.totalMemGb === "number" ? hardware.totalMemGb : 0;
  if (mem > 0 && mem < 8) return "gemma2:2b";
  if (mem > 0 && mem < 12) return "llama3.2";
  return "llama3.1";
}

async function resolveOllamaCommand() {
  const candidates = [
    "ollama",
    "/usr/local/bin/ollama",
    "/opt/homebrew/bin/ollama",
    "/Applications/Ollama.app/Contents/MacOS/ollama"
  ];
  for (const candidate of candidates) {
    if (await hasCommand(candidate)) return candidate;
  }
  return null;
}

function pullOllamaModel(ollamaCmd, model) {
  return new Promise(resolve => {
    output.write(`\nDownloading ${model} via ollama pull...\n`);
    const child = spawn(ollamaCmd, ["pull", model], { stdio: "inherit" });
    child.on("close", code => {
      if (code === 0) {
        output.write(`\nDownloaded ${model}.\n`);
        resolve(true);
      } else {
        output.write(`\nFailed to download ${model}. Exit code ${code}.\n`);
        resolve(false);
      }
    });
    child.on("error", () => resolve(false));
  });
}

function loadCloudModelCatalog() {
  const catalogUrl = new URL("./cloud_model_catalog.json", import.meta.url);
  const raw = fs.readFileSync(catalogUrl, "utf8");
  const json = JSON.parse(raw);
  if (!json || typeof json !== "object") {
    throw new Error("cloud_model_catalog.json must be an object");
  }
  return json;
}

function recommendedBaseUrl(engine) {
  switch (engine) {
    case "mlx":
      return "http://localhost:11434";
    case "llama.cpp":
      return "http://localhost:8080";
    case "vllm":
    case "tensorrt-llm":
    default:
      return "http://localhost:8000";
  }
}

function suggestBaseUrlForProvider(provider) {
  switch (provider) {
    case "openai":
      return "https://api.openai.com/v1";
    case "anthropic":
      return "https://api.anthropic.com";
    case "gemini":
      return "https://generativelanguage.googleapis.com/v1beta";
    case "cohere":
      return "https://api.cohere.com";
    case "mistral":
      return "https://api.mistral.ai/v1";
    case "groq":
      return "https://api.groq.com/openai/v1";
    case "together":
      return "https://api.together.xyz/v1";
    case "perplexity":
      return "https://api.perplexity.ai";
    case "openrouter":
      return "https://openrouter.ai/api";
    case "azure_openai":
      return "https://{resource}.openai.azure.com";
    case "openai_compatible":
    case "auto":
    default:
      return "https://openrouter.ai/api";
  }
}

async function resolveBaseUrl(label, provider, defaultBaseUrl) {
  if (provider === "azure_openai") {
    return await askRequired(`${label} Azure base URL (https://{resource}.openai.azure.com)`);
  }

  const fallback = defaultBaseUrl || "";
  if (!fallback) {
    return await askRequired(`${label} provider base URL`);
  }

  const override = await ask(`Override ${label} base URL`, "no");
  if (override.toLowerCase().startsWith("y")) {
    return await askRequired(`${label} provider base URL`);
  }
  return fallback;
}

async function resolveBaseUrlNoOverride(label, provider, defaultBaseUrl) {
  if (provider === "azure_openai") {
    return await askRequired(`${label} Azure base URL (https://{resource}.openai.azure.com)`);
  }
  return defaultBaseUrl || (await askRequired(`${label} provider base URL`));
}

async function chooseProviderType(label) {
  const options = [
    "openrouter",
    "openai",
    "anthropic",
    "gemini",
    "mistral",
    "cohere",
    "groq",
    "together",
    "perplexity",
    "azure_openai",
    "openai_compatible",
    "auto"
  ];
  while (true) {
    output.write(`\nSelect ${label} provider:\n`);
    options.forEach((option, index) => {
      output.write(`${index + 1}. ${option}\n`);
    });
    const choice = await askRequired("Provider number");
    const asNumber = Number.parseInt(choice, 10);
    if (!Number.isNaN(asNumber) && asNumber >= 1 && asNumber <= options.length) {
      return options[asNumber - 1];
    }
  }
}


function warnIfUnsupported(provider) {
  const supported = new Set([
    "auto",
    "openai_compatible",
    "openrouter",
    "openai",
    "anthropic",
    "gemini",
    "cohere",
    "azure_openai",
    "groq",
    "together",
    "mistral",
    "perplexity"
  ]);
  if (provider && !supported.has(provider)) {
    output.write(
      `Warning: provider adapter '${provider}' is not implemented yet. Use auto/openai_compatible or add an adapter.\n`
    );
  }
}

async function chooseCloudModel(label, provider, baseUrl, apiKey) {
  const resolvedProvider = resolveCatalogProvider(provider, baseUrl, apiKey);
  let options = await fetchModelList({
    provider: resolvedProvider,
    baseUrl,
    apiKey
  });

  if (!options || options.length === 0) {
    const catalog = loadCloudModelCatalog();
    options = Array.isArray(catalog[resolvedProvider]) ? catalog[resolvedProvider] : [];
  }

  const list = options.length ? options : ["custom"];
  while (true) {
    output.write(`\nSelect ${label} model (${resolvedProvider}):\n`);
    output.write("0. Use request model (no override)\n");
    list.forEach((option, index) => {
      output.write(`${index + 1}. ${option}\n`);
    });
    const choice = await askRequired("Model number");
    const asNumber = Number.parseInt(choice, 10);
    if (!Number.isNaN(asNumber)) {
      if (asNumber === 0) return null;
      if (asNumber >= 1 && asNumber <= list.length) {
        const selected = list[asNumber - 1];
        if (selected === "custom") {
          return await askRequired("Enter model id");
        }
        return selected;
      }
    }
    if (choice && Number.isNaN(Number(choice))) {
      return choice;
    }
  }
}

function resolveCatalogProvider(provider, baseUrl, apiKey) {
  if (provider && provider !== "auto") return provider;
  return detectProvider(baseUrl, apiKey) || "openai_compatible";
}

function updateEnv(content, updates) {
  const lines = content.split(/\r?\n/);
  const used = new Set();
  const nextLines = lines.map(line => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match) return line;
    const key = match[1];
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      used.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!used.has(key)) {
      nextLines.push(`${key}=${value}`);
    }
  }

  return nextLines.filter(Boolean).join("\n") + "\n";
}

main().catch(err => {
  output.write(`\nError: ${err?.message || err}\n`);
  rl.close();
  process.exit(1);
});
