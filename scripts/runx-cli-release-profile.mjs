import { spawnSync } from "node:child_process";

import {
  checkRunxGhcrAnonymousAccess,
  githubActionsSkipDirective,
  observeRunxCliCandidateChecks,
  observeRunxCliRelease,
} from "./lib/runx-cli-release-evidence.mjs";

const repository = "runxhq/runx";
const RELEASE_VERIFY_DEADLINE_MS = 55 * 60_000;

const phase = process.argv[2];
const version = requiredEnvironment("RUNX_RELEASE_VERSION");
const channel = requiredEnvironment("RUNX_RELEASE_CHANNEL");

if (channel !== "runx-cli") fail(`unsupported release channel: ${channel}`);
if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) {
  fail(`invalid stable CLI version: ${version}`);
}

const tag = `cli-v${version}`;
const commit = run("git", ["rev-parse", "HEAD"]);

try {
  if (phase === "prepare") await prepare();
  else if (phase === "publish") publish();
  else if (phase === "verify") await verify();
  else fail(`unknown release phase: ${phase ?? "<missing>"}`);
} catch (error) {
  emit({
    status: "failed",
    version,
    channel,
    commit_ref: commit,
    checks: { failure: summarizeFailure(error) },
  });
  process.exitCode = 1;
}

async function prepare() {
  assertCleanCheckout();
  run("git", ["fetch", "origin", "main", "--tags"]);
  assertMainCommit();
  assertTagTriggeredReleaseCommit();
  assertRemoteTagCompatible();
  const candidate = await observeRunxCliCandidateChecks({
    commit,
    githubToken: githubApiToken(),
  });
  if (!candidate.ready) {
    throw new Error(
      `exact candidate commit has not passed release checks: ${candidate.missing.join(", ")}`,
    );
  }
  run("node", ["scripts/check-runx-cli-release-notes.mjs", "--version", version]);
  const ghcrAccess = await checkRunxGhcrAnonymousAccess();
  if (ghcrAccess.status !== "passed") {
    throw new Error(
      "GHCR must be publicly pullable before publication; make the runxhq/runx "
      + "container package public at "
      + "https://github.com/orgs/runxhq/packages/container/runx/settings"
      + `: ${ghcrAccess.detail}`,
    );
  }

  run("pnpm", ["install", "--frozen-lockfile", "--store-dir", ".runx/cache/pnpm"], {
    timeout: 300_000,
  });
  run("pnpm", ["exec", "tsx", "scripts/set-release-version.ts", "--check", version]);
  run("pnpm", ["verify:fast"], {
    cleanRunxEnvironment: true,
    environment: { CARGO_TARGET_DIR: ".runx/cache/release-target" },
    timeout: 840_000,
  });
  assertCleanCheckout();

  emit({
    status: "ready",
    version,
    channel,
    commit_ref: commit,
    checks: {
      clean_checkout: true,
      head_matches_origin_main: true,
      exact_commit_ci: true,
      manifests_match_version: true,
      release_notes: true,
      verify_fast: true,
      remote_tag_compatible: true,
      ghcr_anonymous_access: true,
    },
  });
}

function publish() {
  assertCleanCheckout();
  run("git", ["fetch", "origin", "main", "--tags"]);
  assertMainCommit();

  const remoteCommit = remoteTagCommit();
  if (remoteCommit && remoteCommit !== commit) {
    throw new Error(`${tag} already points to ${remoteCommit}, expected ${commit}`);
  }

  if (!remoteCommit) {
    const localCommit = localTagCommit();
    if (localCommit && localCommit !== commit) {
      throw new Error(`local ${tag} points to ${localCommit}, expected ${commit}`);
    }
    if (!localCommit) run("git", ["tag", "-a", tag, "-m", `Runx CLI ${version}`]);
    run("git", ["push", "origin", `refs/tags/${tag}`]);
  }

  const publishedCommit = remoteTagCommit();
  if (publishedCommit !== commit) {
    throw new Error(`remote ${tag} did not resolve to approved commit ${commit}`);
  }

  emit({
    status: "submitted",
    version,
    channel,
    release_id: tag,
    commit_ref: commit,
    locators: [
      `https://github.com/${repository}/actions/workflows/release.yml`,
      `https://github.com/${repository}/releases/tag/${tag}`,
    ],
    checks: { remote_tag_matches_commit: true },
  });
}

async function verify() {
  const githubToken = githubApiToken();
  const deadline = Date.now() + RELEASE_VERIFY_DEADLINE_MS;
  let observation;
  while (Date.now() < deadline) {
    observation = await releaseObservation(githubToken);
    if (observation.ready) break;
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }

  if (!observation?.ready) {
    const missing = observation?.missing?.join(", ") || "release evidence";
    throw new Error(`timed out waiting for ${tag}: ${missing}`);
  }

  emit({
    status: "verified",
    version,
    channel,
    release_id: tag,
    commit_ref: commit,
    locators: observation.locators,
    checks: Object.fromEntries(
      observation.checks.map((check) => [check.id, check.status === "passed"]),
    ),
  });
}

async function releaseObservation(githubToken) {
  const observation = await observeRunxCliRelease({
    version,
    expectedCommit: commit,
    githubToken,
  });
  const remoteTagMatches = remoteTagCommit() === commit;
  const remoteTagCheck = {
    id: "remote_tag",
    status: remoteTagMatches ? "passed" : "failed",
    detail: remoteTagMatches
      ? `${tag} resolves to ${commit}`
      : `${tag} does not resolve to ${commit}`,
  };
  return {
    ...observation,
    ready: remoteTagMatches && observation.ready,
    checks: [remoteTagCheck, ...observation.checks],
    missing: remoteTagMatches
      ? observation.missing
      : [`remote_tag: ${remoteTagCheck.detail}`, ...observation.missing],
  };
}

function githubApiToken() {
  const environmentToken = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (environmentToken) return environmentToken;
  const result = tryRun("gh", ["auth", "token"]);
  if (!result.ok || !result.stdout) {
    throw new Error("GitHub API authentication is required for release verification");
  }
  return result.stdout;
}

function assertCleanCheckout() {
  const status = run("git", ["status", "--porcelain", "--untracked-files=all"]);
  if (status) throw new Error("release checkout must be clean");
}

function assertMainCommit() {
  const mainCommit = run("git", ["rev-parse", "origin/main"]);
  if (mainCommit !== commit) {
    throw new Error(`release HEAD ${commit} does not match origin/main ${mainCommit}`);
  }
}

function assertTagTriggeredReleaseCommit() {
  const message = run("git", ["show", "-s", "--format=%B", commit]);
  const directive = githubActionsSkipDirective(message);
  if (directive) {
    throw new Error(
      `release commit contains '${directive}', which suppresses the tag-triggered GitHub workflow`,
    );
  }
}

function assertRemoteTagCompatible() {
  const remoteCommit = remoteTagCommit();
  if (remoteCommit && remoteCommit !== commit) {
    throw new Error(`${tag} already points to ${remoteCommit}, expected ${commit}`);
  }
}

function localTagCommit() {
  const result = tryRun("git", ["rev-list", "-n", "1", tag]);
  return result.ok ? result.stdout : "";
}

function remoteTagCommit() {
  const result = tryRun("git", [
    "ls-remote",
    "origin",
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ]);
  if (!result.ok || !result.stdout) return "";
  const refs = new Map(result.stdout.split("\n").map((line) => {
    const [objectId, ref] = line.trim().split(/\s+/, 2);
    return [ref, objectId];
  }));
  return refs.get(`refs/tags/${tag}^{}`) || refs.get(`refs/tags/${tag}`) || "";
}

function summarizeFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n").filter(Boolean).slice(-8).join(" | ").slice(0, 1_000);
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...(options.cleanRunxEnvironment ? withoutRunxEnvironment() : process.env),
      ...(options.environment ?? {}),
      CI: "true",
    },
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].map((value) => value?.trim()).filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function withoutRunxEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("RUNX_")));
}

function tryRun(command, args) {
  try {
    return { ok: true, stdout: run(command, args) };
  } catch (error) {
    return { ok: false, stdout: "", error };
  }
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
