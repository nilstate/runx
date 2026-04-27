#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";

import { createDefaultLocalSkillRuntime } from "@runxhq/adapters";
import { runLocalSkill } from "@runxhq/runtime-local";
import {
  fetchGitHubIssueThread,
  firstNonEmptyString,
  parseGitHubIssueRef,
  selectPreferredGitHubPullRequest,
} from "../tools/thread/github_adapter.mjs";

const args = parseArgs(process.argv.slice(2));
const issueRef = parseGitHubIssueRef(`${requiredFlag(args, "repo")}#issue/${requiredFlag(args, "issue")}`);
const workspace = path.resolve(requiredFlag(args, "workspace"));
const taskId = firstNonEmptyString(args.task_id, args.branch, `issue-${issueRef.issue_number}`);
const branchName = firstNonEmptyString(args.branch, taskId);
const scafldBin = firstNonEmptyString(
  args.scafld_bin,
  process.env.SCAFLD_BIN,
  "/home/kam/dev/scafld/cli/scafld",
);
const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), `runx-github-issue-to-pr-${taskId}-`));
const runtime = await createDefaultLocalSkillRuntime({
  root: runtimeRoot,
  receiptDir: args.receipt_dir ? path.resolve(args.receipt_dir) : undefined,
  runxHome: args.runx_home ? path.resolve(args.runx_home) : undefined,
  env: process.env,
});

const before = fetchGitHubIssueThread({
  adapterRef: issueRef.adapter_ref,
  env: runtime.env,
  cwd: workspace,
});
const caller = await createAnswersCaller(args.answers);
const result = await runLocalSkill({
  skillPath: path.resolve("skills/issue-to-pr"),
  inputs: {
    fixture: workspace,
    task_id: taskId,
    name: branchName,
    thread_title: firstNonEmptyString(before.title, `Issue #${issueRef.issue_number}`),
    thread_body: firstIssueBody(before),
    thread_locator: issueRef.thread_locator,
    thread: before,
    target_repo: issueRef.repo_slug,
    scafld_bin: scafldBin,
  },
  caller,
  adapters: runtime.adapters,
  env: runtime.env,
  receiptDir: runtime.paths.receiptDir,
  runxHome: runtime.paths.runxHome,
});
const after = fetchGitHubIssueThread({
  adapterRef: issueRef.adapter_ref,
  env: runtime.env,
  cwd: workspace,
});

const executionPayload = result.status === "success"
  ? safeJsonParse(result.execution.stdout)
  : undefined;
const preferredBeforePull = selectPreferredGitHubPullRequest(
  before.outbox.map((entry) => ({
    number: optionalNumber(entry.metadata?.number),
    url: entry.locator,
    headRefName: entry.metadata?.branch,
    updatedAt: entry.metadata?.updated_at,
    isDraft: entry.status === "draft",
    state: entry.status === "closed" ? "CLOSED" : "OPEN",
  })),
  branchName,
);
const preferredAfterPull = selectPreferredGitHubPullRequest(
  after.outbox.map((entry) => ({
    number: optionalNumber(entry.metadata?.number),
    url: entry.locator,
    headRefName: entry.metadata?.branch,
    updatedAt: entry.metadata?.updated_at,
    isDraft: entry.status === "draft",
    state: entry.status === "closed" ? "CLOSED" : "OPEN",
  })),
  branchName,
);

const output = {
  status: result.status,
  task_id: taskId,
  repo: issueRef.repo_slug,
  issue: {
    number: issueRef.issue_number,
    url: issueRef.issue_url,
  },
  workspace,
  receipt_dir: runtime.paths.receiptDir,
  runx_home: runtime.paths.runxHome,
  before: summarizeThread(before, preferredBeforePull),
  after: summarizeThread(after, preferredAfterPull),
  execution: executionPayload,
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument: ${token}`);
    }
    const key = token.slice(2).replace(/-/g, "_");
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function requiredFlag(argsRecord, key) {
  const value = firstNonEmptyString(argsRecord[key]);
  if (!value) {
    throw new Error(`--${key.replace(/_/g, "-")} is required.`);
  }
  return value;
}

async function createAnswersCaller(answersPath) {
  const answersDocument = answersPath
    ? safeJsonParse(await readFile(path.resolve(answersPath), "utf8"))
    : { answers: {} };
  const answers = isRecord(answersDocument?.answers) ? answersDocument.answers : {};
  return {
    resolve: async (request) => {
      if (request.kind !== "cognitive_work") {
        return undefined;
      }
      const payload = answers[request.id];
      if (!payload) {
        return undefined;
      }
      return {
        actor: "agent",
        payload,
      };
    },
    report: () => undefined,
  };
}

function firstIssueBody(state) {
  const issueEntry = state.entries.find((entry) => String(entry.entry_id).startsWith("issue-"));
  return firstNonEmptyString(issueEntry?.body);
}

function summarizeThread(state, preferredPull) {
  return {
    entries: state.entries.length,
    outbox: state.outbox.length,
    cursor: state.adapter.cursor,
    preferred_pull_request: preferredPull
      ? {
          number: firstNonEmptyString(preferredPull.number),
          url: firstNonEmptyString(preferredPull.url),
          branch: firstNonEmptyString(preferredPull.headRefName),
          is_draft: preferredPull.isDraft === true,
          state: firstNonEmptyString(preferredPull.state),
        }
      : undefined,
  };
}

function safeJsonParse(value) {
  return JSON.parse(value);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNumber(value) {
  const text = firstNonEmptyString(value);
  return text ? Number(text) : undefined;
}
