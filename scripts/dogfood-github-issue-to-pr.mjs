#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";

import { runLocalSkill } from "../packages/runner-local/src/index.js";
import {
  fetchGitHubIssueSubjectMemory,
  firstNonEmptyString,
  parseGitHubIssueRef,
  selectPreferredGitHubPullRequest,
} from "../tools/subject_memory/github_adapter.mjs";

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
const receiptDir = path.resolve(args.receipt_dir ?? path.join(runtimeRoot, "receipts"));
const runxHome = path.resolve(args.runx_home ?? path.join(runtimeRoot, "home"));

const before = fetchGitHubIssueSubjectMemory({
  adapterRef: issueRef.adapter_ref,
  env: process.env,
  cwd: workspace,
});
const caller = await createAnswersCaller(args.answers);
const result = await runLocalSkill({
  skillPath: path.resolve("skills/issue-to-pr"),
  inputs: {
    fixture: workspace,
    task_id: taskId,
    name: branchName,
    bind_current: false,
    subject_title: firstNonEmptyString(before.subject.title, `Issue #${issueRef.issue_number}`),
    subject_body: firstIssueBody(before),
    subject_locator: issueRef.subject_locator,
    subject_memory: before,
    target_repo: issueRef.repo_slug,
    scafld_bin: scafldBin,
  },
  caller,
  env: process.env,
  receiptDir,
  runxHome,
});
const after = fetchGitHubIssueSubjectMemory({
  adapterRef: issueRef.adapter_ref,
  env: process.env,
  cwd: workspace,
});

const executionPayload = result.status === "success"
  ? safeJsonParse(result.execution.stdout)
  : undefined;
const preferredBeforePull = selectPreferredGitHubPullRequest(
  before.subject_outbox.map((entry) => ({
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
  after.subject_outbox.map((entry) => ({
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
  receipt_dir: receiptDir,
  runx_home: runxHome,
  before: summarizeSubjectMemory(before, preferredBeforePull),
  after: summarizeSubjectMemory(after, preferredAfterPull),
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

function firstIssueBody(memory) {
  const issueEntry = memory.entries.find((entry) => String(entry.entry_id).startsWith("issue-"));
  return firstNonEmptyString(issueEntry?.body);
}

function summarizeSubjectMemory(memory, preferredPull) {
  return {
    entries: memory.entries.length,
    subject_outbox: memory.subject_outbox.length,
    cursor: memory.adapter.cursor,
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
