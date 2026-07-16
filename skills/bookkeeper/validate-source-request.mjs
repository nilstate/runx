// Validate the exact network authority before the composed web-fetch step runs.

function readInputs() {
  return JSON.parse(process.env.RUNX_INPUTS_JSON || "{}");
}

function printableString(value, field, min = 1, max = 500) {
  const text = String(value || "").trim();
  if (text.length < min || text.length > max || /[\u0000-\u001f]/u.test(text)) {
    throw new Error(`${field} must contain ${min}-${max} printable characters.`);
  }
  return text;
}

function exactHost(value, field) {
  const host = printableString(value, field, 1, 253).toLowerCase();
  if (host.endsWith(".") || host.includes("*") || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(host)) {
    throw new Error(`${field} must be an exact DNS host without wildcards or a trailing dot.`);
  }
  return host;
}

function emit(sourceRequest) {
  process.stdout.write(`${JSON.stringify({ source_request: sourceRequest })}\n`);
}

function main() {
  const inputs = readInputs();
  try {
    if (inputs.transactions !== undefined) {
      throw new Error("transactions must be fetched from source_url; direct transaction input is not accepted.");
    }
    if (!Array.isArray(inputs.source_allowlist) || inputs.source_allowlist.length < 1 || inputs.source_allowlist.length > 10) {
      throw new Error("source_allowlist must contain 1-10 exact hosts.");
    }
    const allowlist = [...new Set(inputs.source_allowlist.map((value, index) => exactHost(value, `source_allowlist[${index}]`)))];
    const url = new URL(printableString(inputs.source_url, "source_url"));
    if (!new Set(["http:", "https:"]).has(url.protocol)) {
      throw new Error("source_url must use http or https.");
    }
    if (url.username || url.password) {
      throw new Error("source_url must not contain credentials.");
    }
    url.hash = "";
    const host = exactHost(url.hostname, "source_url host");
    if (!allowlist.includes(host)) {
      throw new Error("source_url host must appear exactly in source_allowlist.");
    }
    emit({
      schema: "runx.bookkeeper.source_request.v1",
      decision: "ready",
      url: url.href,
      host,
      allowlist,
      controls: {
        exact_hosts_only: true,
        credentials_present: false,
        direct_transactions_present: false,
      },
    });
  } catch (error) {
    emit({
      schema: "runx.bookkeeper.source_request.v1",
      decision: "needs_review",
      diagnostics: [{
        id: "runx.bookkeeper.source_request.needs_review",
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
      }],
      controls: {
        exact_hosts_only: false,
      },
    });
  }
}

main();
