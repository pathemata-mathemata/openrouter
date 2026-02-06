---
name: openrouter-router
description: Configure, run, and troubleshoot the OpenRouter hardware-aware classifier router (wizard setup, local model, routing, and dashboard).
---

# OpenRouter Router Skill

Use this skill when you need to set up or operate the OpenRouter router in this repo.

## Quick Workflow
1. Ensure Node.js 20+ is installed.
2. (Optional) Start a local model server (Ollama recommended on Mac).
3. Run the setup wizard: `npm run configure`.
4. Start the router: `npm run dev`.
5. Send OpenAI-compatible requests to `POST /v1/chat/completions`.
6. Check routing headers (`x-openrouter-decision`, `x-openrouter-upstream`).
7. Open the dashboard: `http://localhost:3000/dashboard`.

## Key Rules
- If cheap uses a local base URL, it must use the *same model* as the classifier to avoid Ollama model swapping.
- Keep `CLASSIFIER_SYSTEM_PROMPT` on **one line** in `.env` (dotenv does not support multiline values).
- If classifier calls time out, increase `CLASSIFIER_TIMEOUT_MS` and enable warmup/keep-alive.

## Troubleshooting Guide
- **Classifier always routes to frontier**: check logs for `classifier failed, falling back to frontier` and fix local model availability.
- **Ollama “loading model” errors**: enable warmup (`CLASSIFIER_WARMUP=true`) and keep-alive (`CLASSIFIER_KEEP_ALIVE_MS=60000`).
- **Bad routing decisions**: tighten `CLASSIFIER_SYSTEM_PROMPT` and keep it single-line.

## Reference
See `USAGE.txt` for copy-paste commands and curl examples.
