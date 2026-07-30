import crypto from "node:crypto";
import https from "node:https";

const ALLOWED_ORIGIN = "https://gofrantic.com";
const RECEIPT_PATH = /^\/v1\/receipts\/[a-z0-9]+$/;
const HTTP_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 100_000;

export async function loadFranticFundingTransactions(rawUrls) {
  if (!Array.isArray(rawUrls) || rawUrls.length === 0) {
    throw new Error("receipt_urls must be a non-empty JSON array");
  }
  if (rawUrls.length > 25) {
    throw new Error("receipt_urls may contain at most 25 entries");
  }

  const batches = [];
  for (const rawUrl of rawUrls) {
    const url = validateReceiptUrl(rawUrl);
    const body = await getText(url);
    batches.push(transformFranticReceipt(JSON.parse(body), url.href, body));
  }

  return {
    transactions: batches.flatMap((batch) => batch.transactions),
    receipts: batches.map((batch) => batch.source),
  };
}

export function transformFranticReceipt(document, sourceUrl, rawBody = JSON.stringify(document)) {
  const receipt = document?.receipt;
  const effect = receipt?.payload?.effect;
  if (document?.ok !== true || !receipt || effect?.kind !== "posting.funded") {
    throw new Error("receipt response must contain a posting.funded effect");
  }

  const receiptRef = requiredString(receipt.ref, "receipt.ref");
  const postingId = requiredString(effect.posting_id, "receipt.payload.effect.posting_id");
  const currency = requiredString(effect.currency, "receipt.payload.effect.currency").toUpperCase();
  const occurredAt = requiredString(effect.occurred_at, "receipt.payload.effect.occurred_at");
  const workerLiabilityCents = nonNegativeInteger(
    effect.worker_liability_cents,
    "receipt.payload.effect.worker_liability_cents",
  );
  const feeCents = nonNegativeInteger(effect.fee_cents, "receipt.payload.effect.fee_cents");
  const date = new Date(occurredAt);
  if (Number.isNaN(date.valueOf())) {
    throw new Error("receipt.payload.effect.occurred_at must be an ISO date");
  }

  return {
    transactions: [
      {
        id: `${receiptRef}:worker-liability`,
        date: date.toISOString().slice(0, 10),
        description: `Frantic ${postingId} worker liability funded`,
        amount: workerLiabilityCents / 100,
        currency,
      },
      {
        id: `${receiptRef}:posting-fee`,
        date: date.toISOString().slice(0, 10),
        description: `Frantic ${postingId} demand-side posting fee`,
        amount: -(feeCents / 100),
        currency,
      },
    ],
    source: {
      url: sourceUrl,
      receipt_ref: receiptRef,
      posting_id: postingId,
      published_at: receipt.published_at ?? null,
      sha256: crypto.createHash("sha256").update(rawBody).digest("hex"),
    },
  };
}

export function validateReceiptUrl(rawUrl) {
  const url = new URL(requiredString(rawUrl, "receipt_urls entry"));
  if (
    url.origin !== ALLOWED_ORIGIN
    || !RECEIPT_PATH.test(url.pathname)
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error(`receipt URL is outside the allowlisted Frantic endpoint: ${url.href}`);
  }
  return url;
}

async function getText(url, redirectCount = 0) {
  const response = await request(url);
  if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.location) {
    if (redirectCount >= 3) {
      throw new Error(`GET ${url.href} redirected too many times`);
    }
    return getText(validateReceiptUrl(new URL(response.location, url).href), redirectCount + 1);
  }
  if (response.statusCode < 200 || response.statusCode > 299) {
    throw new Error(`GET ${url.href} returned ${response.statusCode}`);
  }
  return response.body;
}

function request(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: HTTP_TIMEOUT_MS,
      headers: {
        accept: "application/json",
        "user-agent": "runx-bookkeeper/0.1",
      },
    }, (response) => {
      response.setEncoding("utf8");
      let body = "";
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_RESPONSE_BYTES) {
          req.destroy(new Error(`GET ${url.href} exceeded ${MAX_RESPONSE_BYTES} bytes`));
          return;
        }
        body += chunk;
      });
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          location: response.headers.location,
          body,
        });
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error(`GET ${url.href} timed out after ${HTTP_TIMEOUT_MS}ms`));
    });
    req.on("error", reject);
  });
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}
