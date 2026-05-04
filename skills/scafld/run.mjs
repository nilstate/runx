import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const inputs = JSON.parse(process.env.RUNX_INPUTS_JSON || "{}");
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const scafld = resolveBinary(String(inputs.scafld_bin || process.env.SCAFLD_BIN || "scafld"));
const cwd = path.resolve(String(
  inputs.fixture
    || inputs.cwd
    || process.env.RUNX_CWD
    || process.cwd()
));
const taskId = String(inputs.task_id || "");
const command = String(inputs.command || "");
const jsonCommands = new Set([
  "init",
  "plan",
  "harden",
  "approve",
  "status",
  "validate",
  "exec",
  "review",
  "complete",
  "fail",
  "cancel",
  "list",
  "report",
  "build",
]);
const commandsWithoutTaskId = new Set(["init", "list", "report"]);

if (!command) {
  throw new Error("command is required.");
}
if (!commandsWithoutTaskId.has(command) && !taskId) {
  throw new Error("task_id is required.");
}

const args = [];
switch (command) {
  case "init":
  case "list":
  case "report":
    args.push(command);
    break;
  case "plan":
    args.push("plan", taskId);
    if (inputs.title) {
      args.push("--title", String(inputs.title));
    }
    if (inputs.summary) {
      args.push("--summary", String(inputs.summary));
    } else if (inputs.thread_body) {
      args.push("--summary", String(inputs.thread_body));
    }
    if (inputs.thread_title) {
      args.push("--title", String(inputs.thread_title));
    }
    if (inputs.size) {
      args.push("--size", String(inputs.size));
    }
    if (inputs.risk) {
      args.push("--risk", String(inputs.risk));
    }
    if (inputs.acceptance_command) {
      args.push("--command", String(inputs.acceptance_command));
    }
    break;
  case "harden":
    args.push("harden", taskId);
    if (truthy(inputs.mark_passed)) {
      args.push("--mark-passed");
    }
    break;
  case "approve":
  case "status":
  case "validate":
  case "fail":
  case "cancel":
  case "build":
    args.push(command, taskId);
    break;
  case "review":
    args.push("review", taskId);
    if (inputs.provider) {
      args.push("--provider", String(inputs.provider));
    }
    if (inputs.provider_command) {
      args.push("--provider-command", String(inputs.provider_command));
    }
    if (inputs.provider_binary) {
      args.push("--provider-binary", String(inputs.provider_binary));
    }
    if (inputs.model) {
      args.push("--model", String(inputs.model));
    }
    break;
  case "complete":
    args.push("complete", taskId);
    break;
  case "exec":
    args.push("exec", taskId);
    break;
  case "handoff":
    args.push("handoff", taskId);
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

function resolveBinary(candidate) {
  if (!candidate || candidate === "scafld") {
    return "scafld";
  }
  if (!candidate.includes(path.sep)) {
    return candidate;
  }
  return path.isAbsolute(candidate) ? candidate : path.resolve(scriptDirectory, candidate);
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
