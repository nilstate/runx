import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const inputs = JSON.parse(process.env.RUNX_INPUTS_JSON || "{}");
const scafld = String(inputs.scafld_bin || process.env.SCAFLD_BIN || "scafld");
const taskId = String(inputs.task_id || `hosted-scafld-smoke-${Date.now()}`);
const title = String(inputs.title || "Hosted scafld smoke");
const root = mkdtempSync(path.join(tmpdir(), "runx-hosted-scafld-smoke-"));
const readmePath = path.join(root, "README.md");
const steps = [];

try {
  writeFileSync(readmePath, "# hosted scafld smoke\n", "utf8");
  const version = run([scafld, "--version"], root, false).stdout.trim();
  runScafld(["init", "--json"]);
  const plan = runScafld([
    "plan",
    taskId,
    "--title",
    title,
    "--summary",
    "Hosted runx smoke for the pinned scafld release.",
    "--size",
    "micro",
    "--risk",
    "low",
    "--command",
    "test -f README.md",
    "--json",
  ]);
  const validate = runScafld(["validate", taskId, "--json"]);
  const approve = runScafld(["approve", taskId, "--json"]);
  const build = runScafld(["build", taskId, "--json"]);
  const status = runScafld(["status", taskId, "--json"]);
  const handoff = runScafld(["handoff", taskId], false);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    scafld_version: version,
    task_id: taskId,
    plan: JSON.parse(plan.stdout),
    validate: JSON.parse(validate.stdout),
    approve: JSON.parse(approve.stdout),
    build: JSON.parse(build.stdout),
    status: JSON.parse(status.stdout),
    handoff: handoff.stdout,
    steps,
  })}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

function runScafld(args, json = true) {
  return run([scafld, ...args], root, json);
}

function run(command, cwd, parseJson) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    env: sanitizeEnv(process.env),
    encoding: "utf8",
    shell: false,
  });
  const step = {
    command: command.slice(1),
    exit_code: result.status,
  };
  steps.push(step);
  if (result.status !== 0 || result.error) {
    const message = result.error?.message || result.stderr || `${command.join(" ")} exited ${result.status}`;
    throw new Error(message.trim());
  }
  if (parseJson) {
    JSON.parse(result.stdout);
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function sanitizeEnv(env) {
  const clean = { ...env };
  delete clean.RUNX_INPUTS_JSON;
  for (const key of Object.keys(clean)) {
    if (key.startsWith("RUNX_INPUT_")) {
      delete clean[key];
    }
  }
  if (path.isAbsolute(scafld) || scafld.includes(path.sep)) {
    clean.PATH = `${path.dirname(scafld)}${path.delimiter}${clean.PATH || "/usr/local/bin:/usr/bin:/bin"}`;
  }
  return clean;
}
