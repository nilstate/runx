import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const inputs = loadInputs();
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const scafldCandidate = String(inputs.scafld_bin || process.env.SCAFLD_BIN || "scafld");
const scafldSource = inputs.scafld_bin
  ? "input:scafld_bin"
  : process.env.SCAFLD_BIN
    ? "env:SCAFLD_BIN"
    : "path:scafld";
const scafld = resolveBinary(scafldCandidate);
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
    args.push("build", taskId);
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
  ensureScafldVersion({
    scafldBinary: scafld,
    source: scafldSource,
    requestedBinary: scafldCandidate,
    workingDirectory: cwd,
    processEnv: env,
    minimum: minimumScafldVersion,
  });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

if (command === "build_to_review") {
  const outcome = runBuildToReview({
    scafld,
    scafldSource,
    scafldCandidate,
    cwd,
    env,
    taskId,
    maxBuilds: parseMaxBuilds(inputs.max_builds),
  });
  if (outcome.stdout) {
    process.stdout.write(outcome.stdout);
  }
  if (outcome.stderr) {
    process.stderr.write(outcome.stderr);
  }
  process.exit(outcome.exitCode);
}

const result = spawnSync(scafld, args, {
  cwd,
  env,
  encoding: "utf8",
  shell: false,
});

if (result.error) {
  console.error(formatSpawnError({
    error: result.error,
    source: scafldSource,
    requestedBinary: scafldCandidate,
    resolvedBinary: scafld,
    cwd,
    command,
    args,
  }));
  process.exit(1);
}

const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";
const exitCode = result.status ?? 1;

let structured = null;
if (command === "handoff" && exitCode === 0) {
  // scafld handoff emits raw markdown, never JSON. Wrap it in the same
  // `{ ok, command, result }` envelope every other command uses so the runx
  // runner contract (named_emits: result) can expose it at
  // `<step>.result.data.markdown`; base stdout is not addressable.
  structured = {
    ok: true,
    command,
    result: {
      task_id: taskId,
      markdown: stdout,
    },
  };
} else if (jsonCommands.has(command)) {
  try {
    structured = parseJsonPayload(command, stdout);
  } catch (error) {
    if (command === "review" && exitCode === 0) {
      structured = reviewStatusFallback({ scafld, taskId, cwd, env });
    }
    if (structured === null) {
      if (stderr) {
        process.stderr.write(stderr);
      }
      console.error(error.message);
      process.exit(exitCode === 0 ? 1 : exitCode);
    }
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

function formatSpawnError({ error, source, requestedBinary, resolvedBinary, cwd: workingDirectory, command: commandName, args: argv }) {
  const systemCode = error?.code ? ` (${error.code})` : "";
  return [
    `Unable to run scafld ${commandName}.${systemCode}`,
    `- binary source: ${source}`,
    `- requested binary: ${requestedBinary}`,
    `- resolved binary: ${resolvedBinary}`,
    `- cwd: ${workingDirectory}`,
    `- argv: ${[resolvedBinary, ...argv].join(" ")}`,
    `- system error: ${error.message}`,
    "Next: install scafld on PATH, set SCAFLD_BIN to the executable, or pass the scafld_bin input. Verify with `scafld list --json` from the target workspace.",
  ].join("\n");
}

function runBuildToReview({ scafld: scafldBinary, scafldSource: source, scafldCandidate: requestedBinary, cwd: workingDirectory, env: processEnv, taskId: targetTaskId, maxBuilds }) {
  const builds = [];
  let finalStatus = "";
  let lastBuild = null;
  let lastStatus = null;
  let combinedStderr = "";

  for (let attempt = 1; attempt <= maxBuilds; attempt += 1) {
    const buildResult = runNativeJsonCommand({
      scafldBinary,
      source,
      requestedBinary,
      workingDirectory,
      processEnv,
      commandName: "build",
      argv: ["build", targetTaskId, "--json"],
    });
    combinedStderr += buildResult.stderr;

    if (buildResult.errorMessage) {
      return {
        exitCode: buildResult.exitCode,
        stdout: "",
        stderr: `${combinedStderr}${buildResult.errorMessage}\n`,
      };
    }
    if (buildResult.structured) {
      lastBuild = buildResult.structured;
      builds.push({
        attempt,
        command: "build",
        exit_code: buildResult.exitCode,
        result: buildResult.structured.result,
        error: buildResult.structured.error,
      });
      finalStatus = firstNonEmptyString(
        buildResult.structured?.result?.status,
        buildResult.structured?.status,
        finalStatus,
      );
    }
    if (buildResult.exitCode !== 0) {
      return {
        exitCode: buildResult.exitCode,
        stdout: `${JSON.stringify(buildResult.structured)}\n`,
        stderr: combinedStderr,
      };
    }
    if (isReviewReadyStatus(finalStatus)) {
      return buildToReviewSuccess({
        taskId: targetTaskId,
        status: finalStatus,
        builds,
        lastBuild,
        lastStatus,
        stderr: combinedStderr,
      });
    }

    const statusResult = runNativeJsonCommand({
      scafldBinary,
      source,
      requestedBinary,
      workingDirectory,
      processEnv,
      commandName: "status",
      argv: ["status", targetTaskId, "--json"],
    });
    combinedStderr += statusResult.stderr;

    if (statusResult.errorMessage) {
      return {
        exitCode: statusResult.exitCode,
        stdout: "",
        stderr: `${combinedStderr}${statusResult.errorMessage}\n`,
      };
    }
    if (statusResult.structured) {
      lastStatus = statusResult.structured;
      finalStatus = firstNonEmptyString(
        statusResult.structured?.result?.status,
        statusResult.structured?.status,
        finalStatus,
      );
    }
    if (statusResult.exitCode !== 0) {
      return {
        exitCode: statusResult.exitCode,
        stdout: `${JSON.stringify(statusResult.structured)}\n`,
        stderr: combinedStderr,
      };
    }
    if (isReviewReadyStatus(finalStatus)) {
      return buildToReviewSuccess({
        taskId: targetTaskId,
        status: finalStatus,
        builds,
        lastBuild,
        lastStatus,
        stderr: combinedStderr,
      });
    }
  }

  return {
    exitCode: 4,
    stdout: `${JSON.stringify({
      ok: false,
      command: "build_to_review",
      error: {
        code: "build_to_review_exhausted",
        message: `scafld build did not reach review after ${maxBuilds} attempts`,
        exit_code: 4,
      },
      result: {
        task_id: targetTaskId,
        status: finalStatus || undefined,
        max_builds: maxBuilds,
        builds,
        last_build: lastBuild?.result,
        last_status: lastStatus?.result,
      },
    })}\n`,
    stderr: combinedStderr,
  };
}

function runNativeJsonCommand({ scafldBinary, source, requestedBinary, workingDirectory, processEnv, commandName, argv }) {
  const result = spawnSync(scafldBinary, argv, {
    cwd: workingDirectory,
    env: processEnv,
    encoding: "utf8",
    shell: false,
  });
  if (result.error) {
    return {
      exitCode: 1,
      stderr: "",
      errorMessage: formatSpawnError({
        error: result.error,
        source,
        requestedBinary,
        resolvedBinary: scafldBinary,
        cwd: workingDirectory,
        command: commandName,
        args: argv,
      }),
    };
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const exitCode = result.status ?? 1;
  try {
    return {
      exitCode,
      stderr,
      structured: parseJsonPayload(commandName, stdout),
    };
  } catch (error) {
    return {
      exitCode: exitCode === 0 ? 1 : exitCode,
      stderr,
      errorMessage: error.message,
    };
  }
}

function buildToReviewSuccess({ taskId: targetTaskId, status, builds, lastBuild, lastStatus, stderr }) {
  const lastBuildResult = lastBuild?.result ?? {};
  const result = {
    task_id: targetTaskId,
    status,
    passed: lastBuildResult.passed,
    failed: lastBuildResult.failed,
    build_count: builds.length,
    builds,
    last_build: lastBuild?.result,
    last_status: lastStatus?.result,
  };
  return {
    exitCode: 0,
    stdout: `${JSON.stringify({
      ok: true,
      command: "build_to_review",
      result,
    })}\n`,
    stderr,
  };
}

function isReviewReadyStatus(status) {
  return status === "review" || status === "completed";
}

function parseMaxBuilds(value) {
  const parsed = Number.parseInt(String(value || "12"), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return 12;
}

function ensureScafldVersion({ scafldBinary, source, requestedBinary, workingDirectory, processEnv, minimum }) {
  const result = spawnSync(scafldBinary, ["--version"], {
    cwd: workingDirectory,
    env: processEnv,
    encoding: "utf8",
    shell: false,
  });
  if (result.error) {
    throw new Error(formatSpawnError({
      error: result.error,
      source,
      requestedBinary,
      resolvedBinary: scafldBinary,
      cwd: workingDirectory,
      command: "--version",
      args: ["--version"],
    }));
  }

  const exitCode = result.status ?? 1;
  const rawVersion = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (exitCode !== 0) {
    throw new Error(`scafld --version failed with exit ${exitCode}: ${rawVersion}`);
  }

  const required = parseSemver(minimum);
  if (!required) {
    throw new Error(`invalid required scafld version: ${minimum}`);
  }

  const actual = parseSemver(rawVersion);
  if (!actual || compareSemver(actual, required) < 0) {
    throw new Error(
      `scafld ${minimum} or newer is required by this runx runner; ` +
      `resolved ${scafldBinary} reported ${rawVersion || "no version"}`,
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

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
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

function reviewStatusFallback({ scafld: scafldBinary, taskId: targetTaskId, cwd: workingDirectory, env: processEnv }) {
  const result = spawnSync(scafldBinary, ["status", targetTaskId, "--json"], {
    cwd: workingDirectory,
    env: processEnv,
    encoding: "utf8",
    shell: false,
  });
  if (result.error || (result.status ?? 1) !== 0) {
    return null;
  }

  let statusPayload;
  try {
    statusPayload = parseJsonPayload("status", result.stdout ?? "");
  } catch {
    return null;
  }

  const statusResult = unwrapScafldResult(statusPayload);
  const review = statusResult.review && typeof statusResult.review === "object" && !Array.isArray(statusResult.review)
    ? statusResult.review
    : {};
  return {
    ok: true,
    command: "review",
    result: {
      task_id: statusResult.task_id || targetTaskId,
      status: statusResult.status,
      verdict: review.verdict || review.status,
      findings: Array.isArray(review.findings) ? review.findings : [],
      review,
      recovered_from_status: true,
    },
  };
}

function parseJsonPayload(commandName, rawStdout) {
  const trimmed = rawStdout.trim();
  if (!trimmed) {
    throw new Error(`scafld ${commandName} produced no JSON output`);
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const extracted = parseLastJsonObject(trimmed);
    if (extracted) {
      return extracted;
    }
    const preview = trimmed.length > 240 ? `${trimmed.slice(0, 240)}...` : trimmed;
    throw new Error(
      `scafld ${commandName} did not emit valid JSON. ` +
      `This runx binding requires native scafld JSON contracts. Output preview: ${preview}`,
    );
  }
}

function parseLastJsonObject(text) {
  for (let index = text.lastIndexOf("{"); index >= 0; index = text.lastIndexOf("{", index - 1)) {
    try {
      return JSON.parse(text.slice(index));
    } catch {
      continue;
    }
  }
  return null;
}
