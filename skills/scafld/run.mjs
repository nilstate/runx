import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const inputs = JSON.parse(process.env.RUNX_INPUTS_JSON || "{}");
const scafld = String(inputs.scafld_bin || process.env.SCAFLD_BIN || "scafld");
const cwd = path.resolve(String(inputs.fixture || inputs.cwd || process.cwd()));
const taskId = String(inputs.task_id || inputs.taskId || "");
const requested = String(inputs.command || inputs.mode || "");
const command = ({ spec: "new", execute: "exec" })[requested] || requested;

if (!command) {
  throw new Error("command is required.");
}
if (command !== "init" && !taskId) {
  throw new Error("task_id is required.");
}

const args = [];
switch (command) {
  case "init":
    args.push("init");
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
  case "audit":
  case "review":
  case "complete":
  case "validate":
    args.push(command, taskId);
    break;
  case "exec":
    args.push("exec", taskId);
    if (inputs.phase) {
      args.push("--phase", String(inputs.phase));
    }
    break;
  default:
    throw new Error(`Unsupported scafld command: ${command}`);
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
const structured = normalizeStructuredOutput({
  command,
  cwd,
  taskId,
  stdout,
  stderr,
  exitCode,
});

if (structured !== undefined) {
  process.stdout.write(`${JSON.stringify(structured)}\n`);
} else if (stdout) {
  process.stdout.write(stdout);
}

if (stderr) {
  process.stderr.write(stderr);
}

process.exit(exitCode);

function normalizeStructuredOutput(options) {
  switch (options.command) {
    case "validate":
      return buildValidateReport(options);
    case "status":
      return buildStatusReport(options);
    case "review":
      return buildReviewReport(options);
    case "complete":
      return buildCompleteReport(options);
    default:
      return undefined;
  }
}

function buildValidateReport({ cwd: repoRoot, taskId: id, stdout: out, stderr: err, exitCode }) {
  const specPath = findSpecPath(repoRoot, id);
  return {
    task_id: id,
    valid: exitCode === 0,
    status: readSpecStatus(specPath),
    file: toRepoRelative(repoRoot, specPath),
    errors: exitCode === 0 ? [] : collectErrors(out, err),
  };
}

function buildStatusReport({ cwd: repoRoot, taskId: id, stdout: out, stderr: err }) {
  const specPath = findSpecPath(repoRoot, id);
  return {
    task_id: id,
    status: readSpecStatus(specPath),
    file: toRepoRelative(repoRoot, specPath),
    output: [out.trim(), err.trim()].filter(Boolean).join("\n"),
  };
}

function buildReviewReport({ cwd: repoRoot, taskId: id, stdout: out }) {
  return {
    task_id: id,
    status: "review_open",
    review_file: toPosixRelative(path.join(repoRoot, ".ai", "reviews", `${id}.md`), repoRoot),
    review_prompt: out.trim(),
    automated_passes: [],
    required_sections: ["regression_hunt", "convention_check", "dark_patterns"],
  };
}

function buildCompleteReport({ cwd: repoRoot, taskId: id }) {
  const archivePath = findArchivePath(repoRoot, id);
  const reviewPath = path.join(repoRoot, ".ai", "reviews", `${id}.md`);
  const reviewText = existsSync(reviewPath) ? readFileSync(reviewPath, "utf8") : "";
  const completedState = readSpecStatus(archivePath) ?? "completed";
  return {
    task_id: id,
    completed_state: completedState,
    archive_path: toRepoRelative(repoRoot, archivePath),
    review_file: toRepoRelative(repoRoot, reviewPath),
    verdict: extractReviewVerdict(reviewText),
    blocking_count: countMarkdownSectionItems(reviewText, "Blocking"),
    non_blocking_count: countMarkdownSectionItems(reviewText, "Non-blocking"),
  };
}

function collectErrors(stdout, stderr) {
  return [...stdout.split("\n"), ...stderr.split("\n")].map((line) => line.trim()).filter(Boolean);
}

function findSpecPath(repoRoot, id) {
  const directPaths = [
    path.join(repoRoot, ".ai", "specs", "drafts", `${id}.yaml`),
    path.join(repoRoot, ".ai", "specs", "approved", `${id}.yaml`),
    path.join(repoRoot, ".ai", "specs", "active", `${id}.yaml`),
  ];
  for (const candidate of directPaths) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return findArchivePath(repoRoot, id);
}

function findArchivePath(repoRoot, id) {
  const archiveRoot = path.join(repoRoot, ".ai", "specs", "archive");
  if (!existsSync(archiveRoot)) {
    return undefined;
  }
  for (const month of readdirSync(archiveRoot)) {
    const candidate = path.join(archiveRoot, month, `${id}.yaml`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function readSpecStatus(specPath) {
  if (!specPath || !existsSync(specPath)) {
    return undefined;
  }
  const match = readFileSync(specPath, "utf8").match(/^status:\s*"?([^"\n]+)"?\s*$/m);
  return match?.[1]?.trim();
}

function extractReviewVerdict(contents) {
  const section = extractMarkdownSection(contents, "Verdict");
  if (!section) {
    return undefined;
  }
  const verdict = section
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return verdict || undefined;
}

function countMarkdownSectionItems(contents, heading) {
  const section = extractMarkdownSection(contents, heading);
  if (!section) {
    return 0;
  }
  const items = section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ") || /^\d+\.\s/.test(line));
  if (items.length === 1 && /^-+\s*none\.?$/i.test(items[0])) {
    return 0;
  }
  return items.length;
}

function extractMarkdownSection(contents, heading) {
  const marker = `### ${heading}`;
  const start = contents.indexOf(marker);
  if (start < 0) {
    return undefined;
  }
  const afterHeading = contents.slice(start + marker.length);
  const normalized = afterHeading.startsWith("\r\n") ? afterHeading.slice(2) : afterHeading.replace(/^\n/, "");
  const nextHeadingIndex = normalized.indexOf("\n### ");
  if (nextHeadingIndex < 0) {
    return normalized.trim();
  }
  return normalized.slice(0, nextHeadingIndex).trim();
}

function toRepoRelative(repoRoot, filePath) {
  if (!filePath) {
    return null;
  }
  return toPosixRelative(filePath, repoRoot);
}

function toPosixRelative(filePath, repoRoot) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}
