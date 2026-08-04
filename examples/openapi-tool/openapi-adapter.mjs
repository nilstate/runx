// OpenAPI external adapter: turns one OpenAPI operation into an adapter-owned HTTP call.
// It loads the checked-in spec, resolves the requested operationId, validates the
// required parameters, performs the call, and returns the response as the sealed
// result. The network leg lives on the adapter side of the external-adapter
// boundary. If the endpoint is unreachable (e.g. running the bare harness without
// the fixture server), it falls back to resolving the request without calling it,
// so the example stays runnable offline. The extension SDK owns the protocol frame.
import { readFileSync } from "node:fs";
import {
  defineExternalAdapter,
  materializeExternalAdapterInputs,
} from "@runxhq/extension-sdk";

function resolveOperation(spec, operationId) {
  for (const [path, methods] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(methods)) {
      if (op && op.operationId === operationId) {
        return { path, method, op };
      }
    }
  }
  const available = Object.values(spec.paths || {})
    .flatMap((methods) => Object.values(methods))
    .map((op) => op && op.operationId)
    .filter(Boolean);
  throw new Error(`operation '${operationId}' not found; available: ${available.join(", ")}`);
}

function resolveRequest(operation, inputs) {
  let path = operation.path;
  const query = [];
  const missing = [];
  for (const parameter of operation.op.parameters || []) {
    const value = inputs[parameter.name];
    if (value === undefined || value === null) {
      if (parameter.required) missing.push(parameter.name);
      continue;
    }
    if (parameter.in === "path") {
      path = path.replace(`{${parameter.name}}`, encodeURIComponent(value));
    } else if (parameter.in === "query") {
      query.push(`${encodeURIComponent(parameter.name)}=${encodeURIComponent(value)}`);
    }
  }
  if (missing.length) {
    throw new Error(`missing required parameters: ${missing.join(", ")}`);
  }
  return { path, query };
}

const adapter = defineExternalAdapter({
  adapterId: "adapter.example.openapi",
  async invoke({ invocation }) {
    const inputs = materializeExternalAdapterInputs(invocation);
    const spec = JSON.parse(readFileSync(new URL("./openapi.json", import.meta.url)));
    const wanted = inputs.operation_id || inputs.operationId;
    const operation = resolveOperation(spec, wanted);
    const { path, query } = resolveRequest(operation, inputs);

    const base =
      process.env.RUNX_OPENAPI_BASE_URL ||
      (spec.servers && spec.servers[0] && spec.servers[0].url) ||
      "";
    const resolvedUrl = base + path + (query.length ? `?${query.join("&")}` : "");
    const method = operation.method.toUpperCase();
    const resolved = {
      ok: true,
      spec_title: spec.info && spec.info.title,
      operation_id: wanted,
      method,
      resolved_url: resolvedUrl,
    };

    try {
      const response = await fetch(resolvedUrl, { method });
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { ...resolved, executed: true, status_code: response.status, response: body };
    } catch (error) {
      const reason = error && error.message ? error.message : String(error);
      return { ...resolved, executed: false, unreachable: reason };
    }
  },
});

await adapter.main();
