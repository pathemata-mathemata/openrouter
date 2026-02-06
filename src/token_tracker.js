function initBucket() {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    requests: 0,
    withUsage: 0
  };
}

const buckets = {
  cheap: initBucket(),
  medium: initBucket(),
  frontier: initBucket(),
  unknown: initBucket()
};

let lastUpdated = null;

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;

  if (
    typeof usage.prompt_tokens === "number" ||
    typeof usage.completion_tokens === "number" ||
    typeof usage.total_tokens === "number"
  ) {
    const prompt = usage.prompt_tokens ?? 0;
    const completion = usage.completion_tokens ?? 0;
    const total = usage.total_tokens ?? prompt + completion;
    return { prompt, completion, total };
  }

  if (
    typeof usage.input_tokens === "number" ||
    typeof usage.output_tokens === "number" ||
    typeof usage.total_tokens === "number"
  ) {
    const prompt = usage.input_tokens ?? 0;
    const completion = usage.output_tokens ?? 0;
    const total = usage.total_tokens ?? prompt + completion;
    return { prompt, completion, total };
  }

  if (
    typeof usage.promptTokenCount === "number" ||
    typeof usage.candidatesTokenCount === "number" ||
    typeof usage.totalTokenCount === "number"
  ) {
    const prompt = usage.promptTokenCount ?? 0;
    const completion = usage.candidatesTokenCount ?? 0;
    const total = usage.totalTokenCount ?? prompt + completion;
    return { prompt, completion, total };
  }

  return null;
}

function pickBucket(route, upstream) {
  if (route === "medium") return buckets.medium;
  if (route === "frontier") return buckets.frontier;
  if (route === "cheap") return buckets.cheap;
  return buckets.unknown;
}

export function recordUsage({ route, upstream, usage }) {
  const bucket = pickBucket(route, upstream);
  bucket.requests += 1;

  const normalized = normalizeUsage(usage);
  if (!normalized) return;

  bucket.withUsage += 1;
  bucket.promptTokens += normalized.prompt;
  bucket.completionTokens += normalized.completion;
  bucket.totalTokens += normalized.total;
  lastUpdated = Date.now();
}

export function snapshotUsage() {
  const cheap = buckets.cheap.totalTokens;
  const medium = buckets.medium.totalTokens;
  const frontier = buckets.frontier.totalTokens;
  const totalTracked = cheap + medium + frontier;

  const percent = value => (totalTracked > 0 ? Number(((value / totalTracked) * 100).toFixed(2)) : 0);

  return {
    totals: {
      cheap: { ...buckets.cheap },
      medium: { ...buckets.medium },
      frontier: { ...buckets.frontier },
      unknown: { ...buckets.unknown }
    },
    percentages: {
      cheap: percent(cheap),
      medium: percent(medium),
      frontier: percent(frontier)
    },
    totalTrackedTokens: totalTracked,
    lastUpdated
  };
}

export function resetUsage() {
  for (const key of Object.keys(buckets)) {
    buckets[key] = initBucket();
  }
  lastUpdated = null;
}
