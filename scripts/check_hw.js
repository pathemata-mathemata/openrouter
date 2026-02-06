import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

async function hasCommand(cmd, args = ["--help"]) {
  try {
    await execFileAsync(cmd, args, { timeout: 1500 });
    return true;
  } catch (err) {
    return false;
  }
}

async function detectNvidiaVram() {
  try {
    const { stdout } = await execFileAsync("nvidia-smi", [
      "--query-gpu=memory.total",
      "--format=csv,noheader,nounits"
    ]);
    const first = stdout.trim().split(/\s+/)[0];
    const vram = Number.parseInt(first, 10);
    return Number.isNaN(vram) ? null : vram;
  } catch {
    return null;
  }
}

export async function detectHardware() {
  const platform = process.platform;
  const arch = process.arch;
  const totalMemGb = Math.round((os.totalmem() / 1024 / 1024 / 1024) * 10) / 10;
  let engine = "llama.cpp";
  let reason = "default";
  let vramGb = null;

  if (platform === "darwin" && arch === "arm64") {
    engine = "mlx";
    reason = "apple_silicon";
  } else if (await hasCommand("nvidia-smi")) {
    const vram = await detectNvidiaVram();
    if (vram !== null) {
      vramGb = Math.round((vram / 1024) * 10) / 10;
    }
    if (vram !== null && vram >= 24000) {
      engine = "tensorrt-llm";
      reason = `nvidia_vram_${vram}gb`;
    } else {
      engine = "vllm";
      reason = vram !== null ? `nvidia_vram_${vram}gb` : "nvidia_detected";
    }
  } else if (await hasCommand("rocm-smi")) {
    engine = "llama.cpp";
    reason = "amd_rocm_detected";
  }

  return {
    platform,
    arch,
    totalMemGb,
    vramGb,
    engine,
    reason
  };
}

async function main() {
  const result = await detectHardware();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  const current = fileURLToPath(import.meta.url);
  return path.resolve(process.argv[1]) === current;
})();

if (isMain) {
  main().catch(err => {
    process.stderr.write(`${err?.message || err}\n`);
    process.exit(1);
  });
}
