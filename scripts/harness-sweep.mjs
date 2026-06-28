#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const schema = "runx.inline_harness_sweep.v1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultExpectedSkillCount = 76;

try {
  const options = parseArgs(process.argv.slice(2));
  const report = runSweep(options);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    const outputPath = path.resolve(repoRoot, options.output);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, json);
  }
  process.stdout.write(json);
  process.stderr.write(`runx harness sweep: ${report.summary}\n`);
  if (report.status !== "passed") {
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function runSweep(options) {
  const started = performance.now();
  const runxBin = resolveRunxBinary(options);
  const skills = officialSkills();
  const allowed = new Set(options.allowed);
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "runx-harness-sweep-"));
  const workspaceDir = path.join(tempRoot, "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  const results = [];

  try {
    for (const skill of skills) {
      const result = runSkillHarness(skill, runxBin, tempRoot, workspaceDir, allowed);
      results.push(result);
      const label = result.status === "passed"
        ? "PASS"
        : result.status === "allowed_failure"
          ? "ALLOW"
          : "FAIL";
      process.stderr.write(`[harness-sweep] ${label} ${skill.name} ${result.elapsed_ms}ms\n`);
    }
  } finally {
    if (!options.keepTemp) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  const passedSkillCount = results.filter((result) => result.status === "passed").length;
  const allowedFailureCount = results.filter((result) => result.status === "allowed_failure").length;
  const failed = results.filter((result) => result.status === "failed");
  const required = options.require ?? 0;
  const gating = options.require !== undefined;
  const expectedSkillCount = options.expectedCount ?? defaultExpectedSkillCount;
  const failures = [];
  if (skills.length !== expectedSkillCount) {
    failures.push(
      `expected ${expectedSkillCount} official skills, discovered ${skills.length}`,
    );
  }
  if (gating && passedSkillCount < required) {
    failures.push(`required ${required} passing skills, got ${passedSkillCount}`);
  }
  if (gating && failed.length > 0) {
    failures.push(
      `unallowed harness failures: ${failed.map((result) => result.skill).join(", ")}`,
    );
  }

  return {
    schema,
    status: failures.length === 0 ? "passed" : "failed",
    summary: `${passedSkillCount}/${skills.length}`,
    required,
    expected_skill_count: expectedSkillCount,
    discovered_skill_count: skills.length,
    passed_skill_count: passedSkillCount,
    failed_skill_count: failed.length,
    allowed_failure_count: allowedFailureCount,
    allowed_failures: [...allowed].sort(),
    elapsed_ms: Math.round(performance.now() - started),
    runx_bin: path.relative(repoRoot, runxBin),
    temp_root: options.keepTemp ? tempRoot : undefined,
    failures,
    skills: results,
  };
}

function runSkillHarness(skill, runxBin, tempRoot, workspaceDir, allowed) {
  const started = performance.now();
  const skillDir = path.join(repoRoot, "skills", skill.name);
  const receiptDir = path.join(tempRoot, "receipts", skill.name);
  mkdirSync(receiptDir, { recursive: true });

  if (!existsSync(path.join(skillDir, "SKILL.md"))) {
    return failedSkill(skill.name, started, "missing SKILL.md");
  }
  if (!existsSync(path.join(skillDir, "X.yaml"))) {
    return failedSkill(skill.name, started, "missing X.yaml");
  }
  const fixtureFiles = standaloneFixtureFiles(skillDir);
  if (fixtureFiles.length > 0) {
    return runStandaloneFixtureHarness(skill, fixtureFiles, runxBin, tempRoot, receiptDir, started, workspaceDir, allowed);
  }

  const result = spawnSync(
    runxBin,
    ["harness", skillDir, "--json", "--receipt-dir", receiptDir],
    {
      cwd: workspaceDir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: harnessEnv(runxBin, tempRoot, workspaceDir),
    },
  );
  const elapsedMs = Math.round(performance.now() - started);
  const report = parseHarnessReport(result.stdout);
  const error = result.error
    ? result.error.message
    : report.parse_error
      ?? nonEmpty(result.stderr)
      ?? (result.status === 0 ? undefined : `runx exited ${result.status ?? "with signal"}`);
  const passed = result.status === 0 && report.status === "passed";
  const allowedFailure = !passed && allowed.has(skill.name);
  return {
    skill: skill.name,
    status: passed ? "passed" : allowedFailure ? "allowed_failure" : "failed",
    elapsed_ms: elapsedMs,
    exit_status: result.status,
    case_count: report.case_count ?? 0,
    graph_case_count: report.graph_case_count ?? 0,
    assertion_error_count: report.assertion_error_count ?? 0,
    assertion_errors: report.assertion_errors ?? [],
    case_names: report.case_names ?? [],
    receipt_count: Array.isArray(report.receipt_ids) ? report.receipt_ids.length : 0,
    error: passed ? undefined : error,
  };
}

function runStandaloneFixtureHarness(skill, fixtureFiles, runxBin, tempRoot, receiptDir, started, workspaceDir, allowed) {
  const assertionErrors = [];
  const caseNames = [];
  let receiptCount = 0;
  let exitStatus = 0;
  for (const fixturePath of fixtureFiles) {
    const caseName = path.basename(fixturePath).replace(/\.ya?ml$/u, "");
    caseNames.push(caseName);
    const result = spawnSync(
      runxBin,
      ["harness", fixturePath, "--json", "--receipt-dir", receiptDir],
      {
        cwd: workspaceDir,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: harnessEnv(runxBin, tempRoot, workspaceDir),
      },
    );
    if (result.status !== 0 && exitStatus === 0) {
      exitStatus = result.status ?? 1;
    }
    const output = parseHarnessReport(result.stdout);
    if (result.status === 0 && output.schema === "runx.receipt.v1") {
      receiptCount += 1;
      continue;
    }
    assertionErrors.push(
      `${caseName}: ${output.parse_error ?? nonEmpty(result.stderr) ?? `runx exited ${result.status ?? "with signal"}`}`,
    );
  }
  const elapsedMs = Math.round(performance.now() - started);
  const passed = assertionErrors.length === 0;
  const allowedFailure = !passed && allowed.has(skill.name);
  return {
    skill: skill.name,
    status: passed ? "passed" : allowedFailure ? "allowed_failure" : "failed",
    elapsed_ms: elapsedMs,
    exit_status: passed ? 0 : exitStatus,
    case_count: fixtureFiles.length,
    graph_case_count: 0,
    assertion_error_count: assertionErrors.length,
    assertion_errors: assertionErrors,
    case_names: caseNames,
    receipt_count: receiptCount,
    error: passed ? undefined : assertionErrors.join("; "),
  };
}

function standaloneFixtureFiles(skillDir) {
  const fixturesDir = path.join(skillDir, "fixtures");
  if (!existsSync(fixturesDir)) {
    return [];
  }
  return readdirSync(fixturesDir)
    .filter((entry) => entry.endsWith(".yaml") || entry.endsWith(".yml"))
    .sort()
    .map((entry) => path.join(fixturesDir, entry));
}

function failedSkill(skill, started, error) {
  return {
    skill,
    status: "failed",
    elapsed_ms: Math.round(performance.now() - started),
    exit_status: null,
    case_count: 0,
    graph_case_count: 0,
    assertion_error_count: 0,
    assertion_errors: [],
    case_names: [],
    receipt_count: 0,
    error,
  };
}

function resolveRunxBinary(options) {
  const explicit = options.runxBin
    ?? process.env.RUNX_HARNESS_SWEEP_RUNX_BIN
    ?? process.env.RUNX_RUST_CLI_BIN;
  if (explicit) {
    const resolved = path.resolve(repoRoot, explicit);
    if (!existsSync(resolved)) {
      throw new Error(`runx binary does not exist: ${resolved}`);
    }
    return resolved;
  }
  if (!options.noBuild) {
    const result = spawnSync(
      process.platform === "win32" ? "cargo.exe" : "cargo",
      [
        "build",
        "--quiet",
        "--manifest-path",
        "crates/Cargo.toml",
        "-p",
        "runx-cli",
        "--bin",
        "runx",
      ],
      {
        cwd: repoRoot,
        stdio: "inherit",
        env: { ...process.env, CARGO_TERM_COLOR: process.env.CARGO_TERM_COLOR ?? "never" },
      },
    );
    if (result.status !== 0) {
      throw new Error(`cargo build runx failed with exit ${result.status ?? "signal"}`);
    }
  }
  const targetRoot = process.env.CARGO_TARGET_DIR
    ? path.resolve(repoRoot, process.env.CARGO_TARGET_DIR)
    : path.join(repoRoot, "crates", "target");
  const binary = path.join(targetRoot, "debug", process.platform === "win32" ? "runx.exe" : "runx");
  if (!existsSync(binary)) {
    throw new Error(`runx binary does not exist after build: ${binary}`);
  }
  return binary;
}

function officialSkills() {
  const lockPath = path.join(repoRoot, "packages", "cli", "src", "official-skills.lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (!Array.isArray(lock)) {
    throw new Error("official skills lock is not an array");
  }
  return lock
    .map((entry) => {
      if (typeof entry?.skill_id !== "string" || !entry.skill_id.startsWith("runx/")) {
        throw new Error(`invalid official skill entry: ${JSON.stringify(entry)}`);
      }
      return { name: entry.skill_id.slice("runx/".length) };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function harnessEnv(runxBin, tempRoot, workspaceDir) {
  const runxHome = path.join(tempRoot, "runx-home");
  mkdirSync(runxHome, { recursive: true });
  return {
    ...process.env,
    NO_COLOR: "1",
    RUNX_HOME: runxHome,
    RUNX_CWD: workspaceDir,
    RUNX_KERNEL_EVAL_BIN: runxBin,
    RUNX_PARSER_EVAL_BIN: runxBin,
    RUNX_RUST_CLI_BIN: runxBin,
    RUNX_DEV_RUST_CLI_BIN: runxBin,
    RUNX_RECEIPT_SIGN_KID: process.env.RUNX_RECEIPT_SIGN_KID ?? "harness-sweep-test-key",
    RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64:
      process.env.RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64
        ?? "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=",
    RUNX_RECEIPT_SIGN_ISSUER_TYPE: process.env.RUNX_RECEIPT_SIGN_ISSUER_TYPE ?? "hosted",
  };
}

function parseHarnessReport(stdout) {
  const text = stdout.trim();
  if (!text) {
    return { parse_error: "runx produced no JSON on stdout" };
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    return {
      parse_error: `invalid harness JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function parseArgs(argv) {
  const options = {
    allowed: [],
    expectedCount: defaultExpectedSkillCount,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--require") {
      options.require = positiveInteger(requiredValue(argv, ++index, arg), arg);
    } else if (arg === "--allow") {
      options.allowed.push(...requiredValue(argv, ++index, arg).split(",").filter(Boolean));
    } else if (arg === "--expected-count") {
      options.expectedCount = positiveInteger(requiredValue(argv, ++index, arg), arg);
    } else if (arg === "--output") {
      options.output = requiredValue(argv, ++index, arg);
    } else if (arg === "--runx-bin") {
      options.runxBin = requiredValue(argv, ++index, arg);
    } else if (arg === "--no-build") {
      options.noBuild = true;
    } else if (arg === "--keep-temp") {
      options.keepTemp = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error("usage: node scripts/harness-sweep.mjs [--require n] [--allow skill[,skill]] [--expected-count n] [--output path] [--runx-bin path] [--no-build] [--keep-temp]");
    } else {
      throw new Error(`unknown argument '${arg}'`);
    }
  }
  return options;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} requires a non-negative integer`);
  }
  return parsed;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
