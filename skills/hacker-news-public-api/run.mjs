const PROVIDER = "hacker-news-firebase";
const BASE_URL = "https://hacker-news.firebaseio.com/v0";

function normalizedEnvName(name) {
  return `RUNX_INPUT_${name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase()}`;
}

function readInputs() {
  if (!process.env.RUNX_INPUTS_JSON) {
    return {};
  }
  try {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  } catch {
    return {};
  }
}

function readInput(inputs, name, fallback = undefined) {
  const fromEnv = process.env[normalizedEnvName(name)];
  if (fromEnv !== undefined) {
    return fromEnv;
  }
  if (Object.prototype.hasOwnProperty.call(inputs, name)) {
    return inputs[name];
  }
  return fallback;
}

function parsePositiveInteger(value, fieldName, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const text = String(value ?? "").trim();
  if (!/^[0-9]+$/.test(text)) {
    throw Object.assign(new Error(`${fieldName} must be a positive integer`), {
      decision: "needs_input",
    });
  }
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw Object.assign(new Error(`${fieldName} must be between ${min} and ${max}`), {
      decision: "needs_input",
    });
  }
  return number;
}

async function fetchJson(endpoint) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(endpoint, {
      headers: {
        accept: "application/json",
        "user-agent": "runx-hacker-news-public-api/0.1",
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw Object.assign(new Error(`provider returned non-JSON from ${endpoint}`), {
        decision: "needs_more_evidence",
        http_status: response.status,
      });
    }
    if (!response.ok) {
      throw Object.assign(new Error(`provider returned HTTP ${response.status} from ${endpoint}`), {
        decision: "needs_more_evidence",
        http_status: response.status,
      });
    }
    return { http_status: response.status, payload };
  } finally {
    clearTimeout(timeout);
  }
}

function emitReady(request, providerEvidence) {
  console.log(
    JSON.stringify(
      {
        decision: "ready",
        connector: "hacker-news-public-api",
        provider: PROVIDER,
        request,
        provider_evidence: providerEvidence,
        receipt_refs: [],
        stop_conditions: [],
      },
      null,
      2,
    ),
  );
}

function emitFailure(error) {
  const decision = error.decision || "needs_more_evidence";
  console.error(
    JSON.stringify(
      {
        decision,
        connector: "hacker-news-public-api",
        provider: PROVIDER,
        error: error.message,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}

async function runItem(inputs) {
  const itemId = parsePositiveInteger(readInput(inputs, "item_id"), "item_id");
  const endpoint = `${BASE_URL}/item/${itemId}.json`;
  const { http_status, payload } = await fetchJson(endpoint);
  if (payload === null) {
    throw Object.assign(new Error(`item ${itemId} returned null`), {
      decision: "needs_more_evidence",
      http_status,
    });
  }
  emitReady(
    {
      kind: "item",
      endpoint,
      item_id: String(itemId),
      limit: null,
    },
    {
      http_status,
      fetched_at: new Date().toISOString(),
      payload,
    },
  );
}

async function runTopstories(inputs) {
  const limit = parsePositiveInteger(readInput(inputs, "limit", "10"), "limit", {
    min: 1,
    max: 50,
  });
  const endpoint = `${BASE_URL}/topstories.json`;
  const { http_status, payload } = await fetchJson(endpoint);
  if (!Array.isArray(payload)) {
    throw Object.assign(new Error("topstories response was not an array"), {
      decision: "needs_more_evidence",
      http_status,
    });
  }
  emitReady(
    {
      kind: "topstories",
      endpoint,
      item_id: null,
      limit,
    },
    {
      http_status,
      fetched_at: new Date().toISOString(),
      payload: payload.slice(0, limit),
    },
  );
}

const runner = process.argv[2] || "item";
const inputs = readInputs();

try {
  if (runner === "item") {
    await runItem(inputs);
  } else if (runner === "topstories") {
    await runTopstories(inputs);
  } else {
    throw Object.assign(new Error(`unknown runner ${runner}`), { decision: "needs_input" });
  }
} catch (error) {
  emitFailure(error);
}
