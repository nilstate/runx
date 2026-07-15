import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ossRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(ossRoot, "..");

const templates = [
  {
    file: "oss/examples/orchestrator-webhooks/templates/n8n-webhook.manifest.json",
    name: "orchestrators.n8n_webhook_post",
    secret: "RUNX_N8N_WEBHOOK_TOKEN",
    scope: "orchestrator.n8n.workflow.invoke",
    audience: "n8n:workflow:runx-governed-effect",
  },
  {
    file: "oss/examples/orchestrator-webhooks/templates/zapier-webhook.manifest.json",
    name: "orchestrators.zapier_webhook_post",
    secret: "RUNX_ZAPIER_WEBHOOK_TOKEN",
    scope: "orchestrator.zapier.workflow.invoke",
    audience: "zapier:zap:runx-governed-effect",
  },
];

for (const template of templates) {
  const manifest = readJson(template.file);
  assert(manifest.schema === "runx.tool.manifest.v1", `${template.file}: schema mismatch`);
  assert(manifest.name === template.name, `${template.file}: name mismatch`);
  assert(manifest.source?.type === "http", `${template.file}: source.type must be http`);
  assert(manifest.source?.method === "POST", `${template.file}: method must be POST`);
  assert(typeof manifest.source?.url === "string", `${template.file}: source.url is required`);
  assert(manifest.source.url.startsWith("https://"), `${template.file}: source.url must be HTTPS`);
  assert(!/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(manifest.source.url), `${template.file}: webhook URL must not be loopback`);
  assert(!Object.hasOwn(manifest.source, "allow_private_network"), `${template.file}: public webhook template must not allow private networks`);

  const headers = manifest.source.headers ?? {};
  assert(headers.authorization === `Bearer \${secret:${template.secret}}`, `${template.file}: authorization must use ${template.secret}`);
  assert(headers["content-type"] === "application/json", `${template.file}: content-type must be application/json`);
  assert(headers["x-runx-handoff-scope"] === template.scope, `${template.file}: handoff scope header mismatch`);
  assert(headers["x-runx-handoff-audience"] === template.audience, `${template.file}: handoff audience header mismatch`);

  assert(manifest.inputs?.handoff_scope?.default === template.scope, `${template.file}: handoff_scope default mismatch`);
  assert(manifest.inputs?.handoff_audience?.default === template.audience, `${template.file}: handoff_audience default mismatch`);
  assert(manifest.inputs?.event_id?.required === true, `${template.file}: event_id must be required`);
  assert(manifest.inputs?.payload?.required === true, `${template.file}: payload must be required`);
  assert(manifest.scopes?.includes(template.scope), `${template.file}: scopes must include ${template.scope}`);
  assert(manifest.mutating === true, `${template.file}: webhook POST must be marked mutating`);
  assert(manifest.idempotency?.key === "event_id", `${template.file}: idempotency key must be event_id`);
}

const doc = readText("oss/docs/orchestrator-integrations.md");
for (const required of [
  "Cloud orchestrator packages should call the hosted API, not shell out:",
  "runx is the governed execution orchestrator",
  "production HTTPS runx API",
  "self-hosted n8n can consume local MCP HTTP on loopback",
  "It is not the backlink path.",
]) {
  assert(doc.includes(required), `docs missing required boundary: ${required}`);
}

const readme = readText("oss/examples/orchestrator-webhooks/README.md");
assert(readme.includes("templates, not live endpoints"), "example README must state templates are not live endpoints");
assert(readme.includes("Do not paste bearer tokens into the manifest file."), "example README must warn against raw bearer tokens");
assert(
  readme.includes("--credential orchestrator:bearer:RUNX_N8N_WEBHOOK_TOKEN") &&
    readme.includes("--credential-scope orchestrator.n8n.workflow.invoke"),
  "example README must request the n8n handoff scope",
);
assert(readme.includes("Professional n8n Handoff Contract"), "example README must describe the n8n handoff contract");

console.log("orchestrator webhook templates ok");

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function readText(relativePath) {
  return readFileSync(path.resolve(repoRoot, relativePath), "utf8");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
