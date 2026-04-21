import { spawnSync } from "node:child_process";
import path from "node:path";

const inputs = JSON.parse(process.env.RUNX_INPUTS_JSON || "{}");
const scafld = String(inputs.scafld_bin || process.env.SCAFLD_BIN || "scafld");
const cwd = path.resolve(String(
  inputs.fixture
    || inputs.cwd
    || process.env.RUNX_CWD
    || process.cwd()
));
const taskId = String(inputs.task_id || inputs.taskId || "");
const requested = String(inputs.command || inputs.mode || "");
const command = ({ spec: "new", execute: "exec" })[requested] || requested;
const jsonCommands = new Set([
  "init",
  "new",
  "approve",
  "start",
  "status",
  "validate",
  "exec",
  "audit",
  "review",
  "complete",
  "fail",
  "cancel",
  "report",
  "branch",
  "sync",
  "summary",
  "checks",
  "pr-body",
]);
const commandsWithoutTaskId = new Set(["init", "report"]);

if (!command) {
  throw new Error("command is required.");
}
if (!commandsWithoutTaskId.has(command) && !taskId) {
  throw new Error("task_id is required.");
}

const args = [];
switch (command) {
  case "init":
  case "report":
    args.push(command);
    break;
  case "new":
    args.push("new", taskId);
    if (inputs.title || inputs.issue_title || inputs.issueTitle) {
      args.push("-t", String(inputs.title || inputs.issue_title || inputs.issueTitle));
    }
    if (inputs.size) {
      args.push("-s", String(inputs.size));
    }
    if (inputs.risk) {
      args.push("-r", String(inputs.risk));
    }
    break;
  case "approve":
  case "start":
  case "status":
  case "review":
  case "complete":
  case "validate":
  case "sync":
  case "summary":
  case "checks":
  case "pr-body":
  case "fail":
  case "cancel":
    args.push(command, taskId);
    break;
  case "audit":
    args.push("audit", taskId);
    if (inputs.base) {
      args.push("--base", String(inputs.base));
    }
    break;
  case "exec":
    args.push("exec", taskId);
    if (inputs.phase) {
      args.push("--phase", String(inputs.phase));
    }
    break;
  case "branch":
    args.push("branch", taskId);
    if (inputs.name) {
      args.push("--name", String(inputs.name));
    }
    if (inputs.base) {
      args.push("--base", String(inputs.base));
    }
    if (truthy(inputs.bind_current ?? inputs.bindCurrent)) {
      args.push("--bind-current");
    }
    break;
  default:
    throw new Error(`Unsupported scafld command: ${command}`);
}

if (jsonCommands.has(command)) {
  args.push("--json");
}

const env = { ...process.env };
delete env.RUNX_INPUTS_JSON;
for (const key of Object.keys(env)) {
  if (key.startsWith("RUNX_INPUT_")) {
    delete env[key];
  }
}
if (path.isAbsolute(scafld) || scafld.includes(path.sep)) {
  env.PATH = `${path.dirname(scafld)}${path.delimiter}${env.PATH || "/usr/local/bin:/usr/bin:/bin"}`;
}

const result = spawnSync(scafld, args, {
  cwd,
  env,
  encoding: "utf8",
  shell: false,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";
const exitCode = result.status ?? 1;

let structured = null;
if (jsonCommands.has(command)) {
  try {
    structured = parseJsonPayload(command, stdout);
  } catch (error) {
    if (stderr) {
      process.stderr.write(stderr);
    }
    console.error(error.message);
    process.exit(exitCode === 0 ? 1 : exitCode);
  }
}

if (structured !== null) {
  process.stdout.write(`${JSON.stringify(structured)}\n`);
} else if (stdout) {
  process.stdout.write(stdout);
}

if (stderr) {
  process.stderr.write(stderr);
}

process.exit(exitCode);

function truthy(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === undefined || value === null) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseJsonPayload(commandName, rawStdout) {
  const trimmed = rawStdout.trim();
  if (!trimmed) {
    throw new Error(`scafld ${commandName} produced no JSON output`);
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const preview = trimmed.length > 240 ? `${trimmed.slice(0, 240)}...` : trimmed;
    throw new Error(
      `scafld ${commandName} did not emit valid JSON. ` +
      `This runx binding requires native scafld JSON contracts. Output preview: ${preview}`,
    );
  }
}
