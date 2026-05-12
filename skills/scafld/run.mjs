import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const inputs = loadInputs();
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const scafld = resolveBinary(String(inputs.scafld_bin || process.env.SCAFLD_BIN || "scafld"));
const minimumScafldVersion = String(inputs.scafld_min_version || "2.4.0");
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
  "build_to_review",
]);
const commandsWithoutTaskId = new Set(["init", "list", "report"]);

if (!command) {
  throw new Error("scafld command is required. Pass the `command` input through runx.");
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
  case "build_to_review":
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

try {
  ensureScafldVersion({ scafld, cwd, env, minimum: minimumScafldVersion });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

if (command === "build_to_review") {
  const advanced = buildToReview({
    scafld,
    taskId,
    cwd,
    env,
    maxBuilds: positiveInteger(inputs.max_builds, 12),
  });
  if (advanced.stdout) {
    process.stdout.write(advanced.stdout);
  }
  if (advanced.stderr) {
    process.stderr.write(advanced.stderr);
  }
  process.exit(advanced.exitCode);
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

function loadInputs() {
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  return {};
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

function buildToReview({ scafld, taskId, cwd, env, maxBuilds }) {
  const builds = [];
  let passed = 0;
  let failed = 0;

  for (let attempt = 1; attempt <= maxBuilds; attempt += 1) {
    const result = spawnSync(scafld, ["build", taskId, "--json"], {
      cwd,
      env,
      encoding: "utf8",
      shell: false,
    });
    if (result.error) {
      return {
        exitCode: 1,
        stderr: `${result.error.message}\n`,
      };
    }

    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    let structured = null;
    try {
      structured = parseJsonPayload("build", stdout);
    } catch (error) {
      return {
        exitCode: result.status === 0 ? 1 : result.status ?? 1,
        stderr: `${stderr}${error.message}\n`,
      };
    }

    const payload = unwrapScafldResult(structured);
    builds.push(payload);
    passed += Number.isFinite(payload.passed) ? payload.passed : 0;
    failed += Number.isFinite(payload.failed) ? payload.failed : 0;

    const exitCode = result.status ?? 1;
    if (exitCode !== 0) {
      return {
        exitCode,
        stdout: `${JSON.stringify(structured)}\n`,
        stderr,
      };
    }

    if (payload.status === "review") {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({
          ok: true,
          command: "build_to_review",
          result: {
            task_id: payload.task_id || taskId,
            status: payload.status,
            phase: payload.phase,
            passed,
            failed,
            next: payload.next,
            iterations: builds.length,
            builds,
            last: payload,
          },
        })}\n`,
        stderr,
      };
    }
  }

  return {
    exitCode: 1,
    stdout: `${JSON.stringify({
      ok: false,
      command: "build_to_review",
      error: {
        code: "runtime_error",
        message: `scafld build_to_review exceeded ${maxBuilds} build attempts before status review`,
        exit_code: 1,
      },
      result: {
        task_id: taskId,
        status: builds.at(-1)?.status || "unknown",
        passed,
        failed,
        iterations: builds.length,
        builds,
        last: builds.at(-1),
      },
    })}\n`,
  };
}

function unwrapScafldResult(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (value.result && typeof value.result === "object" && !Array.isArray(value.result)) {
      return value.result;
    }
    return value;
  }
  return {};
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function ensureScafldVersion({ scafld, cwd, env, minimum }) {
  const result = spawnSync(scafld, ["--version"], {
    cwd,
    env,
    encoding: "utf8",
    shell: false,
  });
  if (result.error) {
    throw new Error(`could not resolve scafld ${minimum} or newer: ${result.error.message}`);
  }
  const exitCode = result.status ?? 1;
  const rawVersion = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (exitCode !== 0) {
    throw new Error(`scafld --version failed with exit ${exitCode}: ${rawVersion}`);
  }

  const actual = parseSemver(rawVersion);
  const required = parseSemver(minimum);
  if (!required) {
    throw new Error(`invalid required scafld version: ${minimum}`);
  }
  if (!actual || compareSemver(actual, required) < 0) {
    throw new Error(
      `scafld ${minimum} or newer is required by this runx runner; ` +
      `resolved ${scafld} reported ${rawVersion || "no version"}`,
    );
  }
}

function parseSemver(value) {
  const match = String(value).match(/\bv?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?\b/);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] > right[index] ? 1 : -1;
    }
  }
  return 0;
}

function parseJsonPayload(commandName, rawStdout) {
  const trimmed = rawStdout.trim();
  if (!trimmed) {
    throw new Error(`scafld ${commandName} produced no JSON output`);
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const jsonLine = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .reverse()
      .find((line) => line.startsWith("{") && line.endsWith("}"));
    if (jsonLine) {
      try {
        return JSON.parse(jsonLine);
      } catch (lineError) {
        // Continue to the contract error below with the original output preview.
      }
    }
    const preview = trimmed.length > 240 ? `${trimmed.slice(0, 240)}...` : trimmed;
    throw new Error(
      `scafld ${commandName} did not emit valid JSON. ` +
      `This runx binding requires native scafld JSON contracts. Output preview: ${preview}`,
    );
  }
}
