import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Caller } from "@runxhq/core/runner-local";
import { resolvePathFromUserInput } from "@runxhq/core/config";

import type { DocsCommandArgs, DocsCommandDeps, DocsCommandResult } from "./docs-shared.js";
import { readStringFromRecord } from "./docs-shared.js";
import { executeDocsSkill, toDocsSkillFailure } from "./docs-runtime.js";

export async function handleDocsDoctorAction(sourceyRoot: string): Promise<DocsCommandResult> {
  const checks: { status: "pass" | "fail"; message: string }[] = [];
  const packageJson = JSON.parse(await readFile(path.join(sourceyRoot, "package.json"), "utf8")) as Record<string, unknown>;

  await checkFileMissing(sourceyRoot, ".runx/tools/docs/push_pr", "direct docs push_pr tool remains deleted", checks);
  await checkContains(sourceyRoot, "skills/docs-build/X.yaml", "tool: docs.publish_preview", "docs-build publishes a hosted preview surface before maintainer handoff", checks);
  await checkContains(sourceyRoot, "skills/docs-build/X.yaml", "../../.runx/vendor/sourcey/SKILL.md", "docs-build resolves the Sourcey build lane from the repo-local vendored skill bundle", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/prepare_build/src/index.ts", "integration_decision", "docs.prepare_build emits an integration decision for pathway-aware handoff", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/score_quality/src/index.ts", "existing_surface", "docs.score_quality records the visible docs surface", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/score_quality/src/index.ts", "contractProfile", "docs.score_quality keeps contract-led rationale wired into the build recommendation", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/research_context/src/index.ts", "existing_surface", "docs.research_context carries the visible docs surface into the grounded brief", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_build/src/index.ts", "Hosted preview", "docs.package_build records hosted preview evidence in the build summary", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_build/src/index.ts", "integration_decision", "docs.package_build carries the integration decision into the docs packet", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_build/src/index.ts", "coverage_assessment", "docs.package_build records preview coverage against the current docs surface", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_build/src/index.ts", "regresses the maintainer's existing visible docs surface", "docs.package_build blocks native patches that shrink the visible docs surface", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_build/src/index.ts", "substantive_file_count", "docs.package_build tracks substantive authored docs files", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_build/src/index.ts", "scaffold-only", "docs.package_build blocks scaffold-only bundles from opening PRs", checks);
  await checkContains(sourceyRoot, "skills/docs-build/X.yaml", "\"existing_surface\": {", "docs-build brief shape records the current visible docs surface", checks);
  await checkContains(sourceyRoot, ".runx/vendor/sourcey/X.yaml", "When project_brief is supplied, it is the quality bar:", "vendored Sourcey runner consumes the grounded brief during authoring", checks);
  await checkContains(sourceyRoot, ".runx/vendor/sourcey/X.yaml", "existing_surface.visible_paths", "vendored Sourcey runner preserves the current visible docs footprint", checks);
  await checkContains(sourceyRoot, "skills/docs-pr/X.yaml", "thread:", "docs-pr declares a thread input", checks);
  await checkContains(sourceyRoot, "skills/docs-pr/X.yaml", "required: true", "docs-pr requires the GitHub control thread", checks);
  await checkContains(sourceyRoot, "skills/docs-pr/X.yaml", "default: false", "docs-pr defaults push_pr to false", checks);
  await checkContains(sourceyRoot, "skills/docs-pr/X.yaml", "tool: docs.stage_pr", "docs-pr stages the bounded upstream docs bundle directly", checks);
  await checkNotContains(sourceyRoot, "skills/docs-pr/X.yaml", "../../.runx/vendor/issue-to-pr", "docs-pr no longer routes maintainer-facing docs work through the nested issue-to-pr lane", checks);
  await checkContains(sourceyRoot, "skills/docs-pr/X.yaml", "tool: thread.push_outbox", "docs-pr publishes through thread.push_outbox", checks);
  await checkFileExists(sourceyRoot, ".runx/tools/docs/stage_pr/run.mjs", "docs.stage_pr tool is present", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/stage_pr/src/index.ts", "migration_bundle.files", "docs.stage_pr stages the authored upstream docs bundle", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/stage_pr/src/index.ts", "commit_subject", "docs.stage_pr carries the reviewed commit subject into the PR draft", checks);
  await checkFileMissing(sourceyRoot, "scripts/ensure-runx-runtime.mjs", "the old installed-runtime patch script is gone; Sourcey uses the real CLI directly", checks);
  await checkFileMissing(sourceyRoot, "scripts/runx-local.mjs", "the old local runx shim is gone; Sourcey uses the real CLI directly", checks);
  await checkFileMissing(sourceyRoot, "scripts/doctor-outreach-flow.mjs", "the old outreach doctor harness is gone; `runx docs doctor` is canonical", checks);
  await checkFileMissing(sourceyRoot, "scripts/dogfood-outreach-flow.mjs", "the old outreach dogfood harness is gone; `runx docs dogfood` is canonical", checks);
  await checkNotContains(sourceyRoot, ".runx/tools/docs/prepare_pr/src/index.ts", "docs://refresh/", "docs-pr no longer invents synthetic thread locators", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/prepare_pr/src/index.ts", "hosted preview URL", "docs.prepare_pr rejects local temp preview paths", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/prepare_pr/src/index.ts", "Integration decision", "docs.prepare_pr carries the integration decision into the review request", checks);
  await checkContains(sourceyRoot, "skills/docs-outreach/X.yaml", "thread:", "docs-outreach declares a thread input", checks);
  await checkContains(sourceyRoot, "skills/docs-outreach/X.yaml", "required: true", "docs-outreach requires the GitHub control thread", checks);
  await checkContains(sourceyRoot, "skills/docs-outreach/X.yaml", "default: false", "docs-outreach defaults push_outreach to false", checks);
  await checkContains(sourceyRoot, "skills/docs-outreach/X.yaml", "tool: thread.push_outbox", "docs-outreach publishes review through thread.push_outbox", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_pr/src/index.ts", "handoff_ref", "docs.package_pr emits a reusable handoff_ref", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_pr/src/index.ts", "## Preview Site", "docs.package_pr includes the hosted preview site in review and PR bodies", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_pr/src/index.ts", "## Integration Path", "docs.package_pr includes the integration path in review and PR bodies", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_pr/src/index.ts", "## Exact Commit Subject", "docs.package_pr review message includes the exact commit subject", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_pr/src/index.ts", "## Exact PR Title", "docs.package_pr review message includes the exact PR title", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_pr/src/index.ts", "## Exact PR Body", "docs.package_pr review message includes the exact PR body", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_outreach/src/index.ts", "outreach_message_markdown", "docs.package_outreach emits the exact outreach body", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_outreach/src/index.ts", "review_message_markdown", "docs.package_outreach emits the exact review message", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_outreach/src/index.ts", "## Integration Path", "docs.package_outreach includes the integration path in review and outreach surfaces", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_outreach/src/index.ts", "## Exact Outreach Body", "docs.package_outreach review message includes the exact outreach body", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_outreach/src/index.ts", "substantive docs bundle", "docs.package_outreach refuses scaffold-only external outreach", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_signal/src/index.ts", "runx.handoff_signal.v1", "docs.package_signal emits the generic handoff signal contract", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/handoff.mjs", "@runxhq/core/knowledge", "docs handoff reduction delegates to the core knowledge reducer", checks);
  await checkContains(sourceyRoot, ".runx/tools/docs/package_signal/src/index.ts", "runx.suppression_record.v1", "docs.package_signal emits the generic suppression contract", checks);
  checkPinnedCliDependency(packageJson, checks);
  await checkNoDirectGitHubMutation(sourceyRoot, ".runx/tools/docs", checks);
  await checkContains(sourceyRoot, "package.json", "\"doctor:outreach\": \"runx docs doctor\"", "package.json routes doctor:outreach through the runx CLI", checks);
  await checkContains(sourceyRoot, "package.json", "\"dogfood:outreach\": \"runx docs dogfood\"", "package.json routes dogfood:outreach through the runx CLI", checks);

  const failed = checks.filter((check) => check.status === "fail");
  return failed.length === 0
    ? {
        status: "success",
        action: "doctor",
        summary: `All outreach-flow checks passed (${checks.length}/${checks.length}).`,
        checks,
      }
    : {
        status: "failure",
        action: "doctor",
        message: `${failed.length} outreach-flow checks failed.`,
      };
}

export async function handleDocsDogfoodAction(
  parsed: DocsCommandArgs,
  env: NodeJS.ProcessEnv,
  caller: Caller,
  deps: DocsCommandDeps,
  sourceyRoot: string,
): Promise<DocsCommandResult> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "runx-docs-dogfood-"));
  const repoRoot = path.join(tempRoot, "target-repo");
  const runtimeRoot = path.join(tempRoot, "runtime");
  const receiptDir = parsed.receiptDir
    ? resolvePathFromUserInput(parsed.receiptDir, env)
    : path.join(runtimeRoot, "receipts");
  const threadPath = path.join(runtimeRoot, "control-thread.json");
  const taskId = "docs-refresh-easyllm";
  try {
    await mkdir(repoRoot, { recursive: true });
    await mkdir(receiptDir, { recursive: true });
    await initDogfoodRepo(repoRoot);
    const thread = await writeDogfoodControlThread(threadPath);
    const skillEnv = { ...env, RUNX_CWD: sourceyRoot };

    const docsPr = await executeDocsSkill(
      sourceyRoot,
      "docs-pr",
      {
        repo_root: repoRoot,
        docs_build_packet: buildDogfoodDocsPrPacket(),
        thread,
        task_id: taskId,
        push_pr: true,
        pr_context: "Review the packaged PR text in this control thread before any upstream send.",
      },
      skillEnv,
      caller,
      { ...parsed, receiptDir },
      deps,
    );
    if (docsPr.result.status !== "success" || !docsPr.data) {
      return toDocsSkillFailure("dogfood", undefined, "review", docsPr.result);
    }
    const readmeContents = await readFile(path.join(repoRoot, "README.md"), "utf8");
    const gettingStartedContents = await readFile(path.join(repoRoot, "docs/getting-started.md"), "utf8");
    if (readmeContents !== DOGFOOD_README_CONTENTS || gettingStartedContents !== DOGFOOD_GETTING_STARTED_CONTENTS) {
      return {
        status: "failure",
        action: "dogfood",
        message: "docs-pr dogfood did not stage the expected authored docs bundle into the repo clone.",
      };
    }

    const docsOutreach = await executeDocsSkill(
      sourceyRoot,
      "docs-outreach",
      {
        repo_root: repoRoot,
        docs_build_packet: buildDogfoodDocsOutreachPacket(),
        thread,
        maintainer_contact: {
          channel: "email",
          email: "maintainer@example.org",
          display_name: "Maintainer",
        },
        outreach_context: "Invite maintainers to review the hosted preview and suggest the lowest-friction adoption path.",
        push_outreach: true,
      },
      skillEnv,
      caller,
      { ...parsed, receiptDir },
      deps,
    );
    if (docsOutreach.result.status !== "success" || !docsOutreach.data) {
      return toDocsSkillFailure("dogfood", undefined, "review", docsOutreach.result);
    }

    const docsSignal = await executeDocsSkill(
      sourceyRoot,
      "docs-signal",
      {
        docs_pr_packet: docsPr.data,
        signal_source: "pull_request_review",
        signal_disposition: "requested_changes",
        recorded_at: "2026-04-24T04:00:00Z",
      },
      skillEnv,
      caller,
      { ...parsed, receiptDir },
      deps,
    );
    if (docsSignal.result.status !== "success" || !docsSignal.data) {
      return toDocsSkillFailure("dogfood", undefined, "signal", docsSignal.result);
    }
    if (readStringFromRecord(docsSignal.data, ["handoff_state", "status"]) !== "needs_revision") {
      return {
        status: "failure",
        action: "dogfood",
        message: "docs-signal dogfood did not reduce PR review feedback to needs_revision.",
      };
    }

    const outreachSuppression = await executeDocsSkill(
      sourceyRoot,
      "docs-signal",
      {
        docs_outreach_packet: {
          handoff_ref: {
            handoff_id: "sourcey.docs-outreach:docs-outreach-easyllm",
            boundary_kind: "external_contact",
            target_repo: "philschmid/easyllm",
            target_locator: "github://sourcey/sourcey.com/issues/2",
            contact_locator: "mailto:maintainer@example.org",
            thread_locator: "github://sourcey/sourcey.com/issues/2",
            outbox_entry_id: "message:docs-outreach-easyllm:outreach",
          },
        },
        signal_source: "email_reply",
        signal_disposition: "requested_no_contact",
        suppression_reason: "requested_no_contact",
        recorded_at: "2026-04-24T04:05:00Z",
      },
      skillEnv,
      caller,
      { ...parsed, receiptDir },
      deps,
    );
    if (outreachSuppression.result.status !== "success" || !outreachSuppression.data) {
      return toDocsSkillFailure("dogfood", undefined, "signal", outreachSuppression.result);
    }
    if (readStringFromRecord(outreachSuppression.data, ["handoff_state", "status"]) !== "suppressed") {
      return {
        status: "failure",
        action: "dogfood",
        message: "docs-signal dogfood did not suppress outreach when requested.",
      };
    }

    return {
      status: "success",
      action: "dogfood",
      summary: "Thread-first docs dogfood passed for review packaging, adapter-managed push, signal reduction, and outreach suppression.",
      receipts: {
        docs_pr: docsPr.result.receipt?.id,
        docs_outreach: docsOutreach.result.receipt?.id,
        docs_signal: docsSignal.result.receipt?.id,
        docs_outreach_signal: outreachSuppression.result.receipt?.id,
      },
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function checkContains(
  root: string,
  relativePath: string,
  pattern: string,
  message: string,
  checks: { status: "pass" | "fail"; message: string }[],
): Promise<void> {
  const contents = await readFile(path.join(root, relativePath), "utf8");
  checks.push({ status: contents.includes(pattern) ? "pass" : "fail", message });
}

async function checkNotContains(
  root: string,
  relativePath: string,
  pattern: string,
  message: string,
  checks: { status: "pass" | "fail"; message: string }[],
): Promise<void> {
  const contents = await readFile(path.join(root, relativePath), "utf8");
  checks.push({ status: contents.includes(pattern) ? "fail" : "pass", message });
}

async function checkFileMissing(
  root: string,
  relativePath: string,
  message: string,
  checks: { status: "pass" | "fail"; message: string }[],
): Promise<void> {
  checks.push({ status: existsSync(path.join(root, relativePath)) ? "fail" : "pass", message });
}

async function checkFileExists(
  root: string,
  relativePath: string,
  message: string,
  checks: { status: "pass" | "fail"; message: string }[],
): Promise<void> {
  checks.push({ status: existsSync(path.join(root, relativePath)) ? "pass" : "fail", message });
}

function checkPinnedCliDependency(
  packageJson: Record<string, unknown>,
  checks: { status: "pass" | "fail"; message: string }[],
): void {
  const dependencies = readRecord(packageJson.dependencies);
  const devDependencies = readRecord(packageJson.devDependencies);
  const version = firstNonEmptyString(dependencies?.["@runxhq/cli"], devDependencies?.["@runxhq/cli"]);
  checks.push({
    status: typeof version === "string" && (version.startsWith("file:vendor/runx/") || /^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) ? "pass" : "fail",
    message: typeof version === "string" && (version.startsWith("file:vendor/runx/") || /^[0-9]+\.[0-9]+\.[0-9]+$/.test(version))
      ? `Sourcey pins @runxhq/cli deterministically (${version})`
      : "Sourcey must pin @runxhq/cli deterministically for repeatable outreach runs",
  });
}

async function checkNoDirectGitHubMutation(
  root: string,
  relativePath: string,
  checks: { status: "pass" | "fail"; message: string }[],
): Promise<void> {
  const files = await collectFiles(path.join(root, relativePath));
  const regex = /\bgh\s+(?:pr|issue|api)\b/;
  const offenders: string[] = [];
  for (const filePath of files) {
    const contents = await readFile(filePath, "utf8");
    if (regex.test(contents)) {
      offenders.push(path.relative(root, filePath));
    }
  }
  checks.push({
    status: offenders.length === 0 ? "pass" : "fail",
    message: offenders.length === 0
      ? "docs tools do not bypass the thread adapter with direct gh mutation"
      : `direct gh mutation detected in ${offenders.join(", ")}`,
  });
}

async function collectFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(absolute));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

async function initDogfoodRepo(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, "docs"), { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "dogfood@example.com"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Dogfood Runner"], { cwd: repoRoot, stdio: "ignore" });
  await writeFile(path.join(repoRoot, "README.md"), "# EasyLLM\n\nStarter docs.\n", "utf8");
  await writeFile(path.join(repoRoot, "docs/getting-started.md"), "# Getting Started\n\nPlaceholder content.\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "ignore" });
}

async function writeDogfoodControlThread(threadPath: string): Promise<Record<string, unknown>> {
  const thread = {
    kind: "runx.thread.v1",
    adapter: {
      type: "file",
      adapter_ref: threadPath,
    },
    thread_kind: "work_item",
    thread_locator: "github://sourcey/sourcey.com/issues/2",
    canonical_uri: "https://github.com/sourcey/sourcey.com/issues/2",
    title: "EasyLLM docs refresh review",
    entries: [],
    decisions: [],
    outbox: [],
    source_refs: [],
  };
  await writeFile(threadPath, `${JSON.stringify(thread, null, 2)}\n`, "utf8");
  return thread;
}

function buildDogfoodDocsPrPacket(): Record<string, unknown> {
  return {
    status: "generated",
    scan: {
      target: {
        repo_slug: "philschmid/easyllm",
        repo_url: "https://github.com/philschmid/easyllm",
        default_branch: "main",
      },
      adoption_profile: {
        lane: "general-docs",
      },
      quality_assessment: {
        quality_band: "thin",
      },
    },
    integration_decision: {
      pathway: "native_patch",
      recommended_handoff: "pull_request",
      upstream_change_shape: "Patch the repository's native docs stack in place.",
      why_this_path: "The repo already has a native docs surface to improve.",
    },
    before_after_evidence: {
      build_url: "https://sourcey.com/previews/easyllm/index.html",
      preview_screenshot_url: "https://sourcey.com/previews/easyllm/preview.png",
      current_docs_url: "https://github.com/philschmid/easyllm#readme",
      summary: "Rendered docs build verified successfully with 2 authored file changes.",
    },
    migration_bundle: {
      summary: "Prepared a focused docs refresh for the README quickstart and getting started page.",
      files: [
        { path: "README.md", contents: DOGFOOD_README_CONTENTS },
        { path: "docs/getting-started.md", contents: DOGFOOD_GETTING_STARTED_CONTENTS },
      ],
    },
    operator_summary: {
      should_open_pr: true,
      rationale: "The current docs are thin and the generated build is materially stronger.",
    },
    maintainer_handoff: {
      pr_title: "docs: refresh README quickstart and getting started guide",
      commit_subject: "docs: refresh quickstart and getting started guide",
    },
    project_brief: {
      current_docs_audit: {
        verdict: "Thin quickstart coverage with no real getting-started path.",
        preserve: ["Keep the repository README as the first landing surface."],
        gaps_addressed: ["Turn the placeholder getting-started page into a real path with setup and first-run guidance."],
      },
    },
  };
}

function buildDogfoodDocsOutreachPacket(): Record<string, unknown> {
  return {
    status: "generated",
    scan: {
      target: {
        repo_slug: "philschmid/easyllm",
        repo_url: "https://github.com/philschmid/easyllm",
        default_branch: "main",
      },
      adoption_profile: {
        lane: "docs_engagement",
      },
      quality_assessment: {
        quality_band: "thin",
      },
    },
    integration_decision: {
      pathway: "outreach_only",
      recommended_handoff: "outreach",
      upstream_change_shape: "Lead with a hosted preview and propose the lowest-friction adoption path before requesting a patch.",
      why_this_path: "The maintainer may prefer to review the hosted preview before choosing an adoption path.",
    },
    before_after_evidence: {
      build_url: "https://sourcey.com/previews/easyllm/index.html",
      preview_screenshot_url: "https://sourcey.com/previews/easyllm/preview.png",
      current_docs_url: "https://github.com/philschmid/easyllm#readme",
      summary: "Prepared a hosted preview plus a substantive docs bundle for maintainer review.",
    },
    migration_bundle: {
      summary: "Prepared a README quickstart and getting-started refresh bundle for maintainer review.",
      files: [
        { path: "README.md", contents: DOGFOOD_README_CONTENTS },
        { path: "docs/getting-started.md", contents: DOGFOOD_GETTING_STARTED_CONTENTS },
      ],
    },
    operator_summary: {
      recommended_handoff: "outreach",
      rationale: "Lead with the hosted preview and let maintainers choose whether they want a PR, a sidecar docs site, or a smaller starter patch.",
    },
    maintainer_handoff: {
      outreach_subject: "Preview a refreshed docs experience for EasyLLM",
    },
  };
}

const DOGFOOD_README_CONTENTS = `# EasyLLM

## Quickstart

Use the generated docs preview to give maintainers a full proposed docs experience before opening an upstream PR.

1. Install the project dependencies.
2. Export the provider credentials required for local runs.
3. Run the sample notebook or script from docs/getting-started.md.
`;

const DOGFOOD_GETTING_STARTED_CONTENTS = `# Getting Started

## Setup

Install the project dependencies and configure the provider credentials before running the examples.

## First Run

Execute the sample script and compare the output to the hosted Sourcey preview so maintainers can review the exact documentation proposal before merge.
`;

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstNonEmptyString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}
