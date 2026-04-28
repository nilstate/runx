import { createInterface } from "node:readline/promises";
import { readFile } from "node:fs/promises";

import type { Question, ResolutionRequest, ResolutionResponse } from "@runxhq/core/executor";
import type { Caller } from "@runxhq/runtime-local";

import type { CliAgentRuntime } from "./agent-runtime.js";
import { loadCliAgentRuntime } from "./agent-runtime.js";
import { renderExecutionEvent } from "./cli-presentation.js";
import type { CliIo } from "./index.js";
import { theme } from "./ui.js";

interface CallerInputFile {
  readonly answers: Readonly<Record<string, unknown>>;
  readonly approvals?: boolean | Readonly<Record<string, boolean>>;
}

export function createNonInteractiveCaller(
  answers: Readonly<Record<string, unknown>> = {},
  approvals?: boolean | Readonly<Record<string, boolean>>,
  loadAgentRuntime?: () => Promise<CliAgentRuntime | undefined>,
): Caller {
  return {
    resolve: async (request) => resolveNonInteractiveRequest(request, answers, approvals, loadAgentRuntime),
    report: () => undefined,
  };
}

export function createInteractiveCaller(
  io: CliIo,
  answers: Readonly<Record<string, unknown>> = {},
  approvals?: boolean | Readonly<Record<string, boolean>>,
  options: { readonly reportEvents?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
  loadAgentRuntime?: () => Promise<CliAgentRuntime | undefined>,
): Caller {
  return {
    resolve: async (request) => resolveInteractiveRequest(request, io, answers, approvals, loadAgentRuntime),
    report: (event) => {
      if (options.reportEvents === false) {
        return;
      }
      const rendered = renderExecutionEvent(event, io, env);
      if (rendered) {
        io.stdout.write(rendered);
      }
    },
  };
}

export function createAgentRuntimeLoader(
  env: NodeJS.ProcessEnv,
): () => Promise<CliAgentRuntime | undefined> {
  let runtimePromise: Promise<CliAgentRuntime | undefined> | undefined;
  return async () => {
    runtimePromise ??= loadCliAgentRuntime(env);
    return await runtimePromise;
  };
}

export async function readCallerInputFile(answersPath: string): Promise<CallerInputFile> {
  const parsed = JSON.parse(await readFile(answersPath, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("--answers file must contain a JSON object.");
  }
  if (parsed.answers === undefined && parsed.approvals === undefined) {
    return {
      answers: parsed,
    };
  }
  const extraTopLevelKeys = Object.keys(parsed).filter(
    (key) => key !== "answers" && key !== "approvals",
  );
  if (extraTopLevelKeys.length > 0) {
    throw new Error(
      `--answers file mixes top-level keys [${extraTopLevelKeys.join(", ")}] with the nested 'answers'/'approvals' shape. ` +
        "Use either the flat shape (top-level keys = answers, no 'approvals') " +
        "or the nested shape ({ answers: {...}, approvals: {...} }), not both.",
    );
  }
  if (parsed.answers !== undefined && !isRecord(parsed.answers)) {
    throw new Error("--answers answers field must be an object.");
  }
  return {
    answers: parsed.answers === undefined ? {} : parsed.answers,
    approvals: validateCallerApprovals(parsed.approvals),
  };
}

async function approveGate(
  gate: { readonly id: string; readonly reason: string },
  io: CliIo,
  approvals?: boolean | Readonly<Record<string, boolean>>,
): Promise<boolean> {
  const provided = resolveApproval(gate.id, approvals);
  if (provided !== undefined) {
    return provided;
  }

  const rl = createInterface({
    input: io.stdin,
    output: io.stdout,
  });
  const t = theme(io.stdout);

  try {
    io.stdout.write(`\n  ${t.yellow}◆${t.reset}  ${t.bold}approval needed${t.reset}\n`);
    io.stdout.write(`  ${t.dim}gate${t.reset}    ${gate.id}\n`);
    io.stdout.write(`  ${t.dim}reason${t.reset}  ${gate.reason}\n\n`);
    const answer = (await rl.question(`  ${t.cyan}›${t.reset} Approve? [y/N] `)).trim().toLowerCase();
    io.stdout.write("\n");
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function resolveNonInteractiveRequest(
  request: ResolutionRequest,
  answers: Readonly<Record<string, unknown>> = {},
  approvals?: boolean | Readonly<Record<string, boolean>>,
  loadAgentRuntime?: () => Promise<CliAgentRuntime | undefined>,
): Promise<ResolutionResponse | undefined> {
  if (request.kind === "input") {
    const payload = pickAnswers(request.questions, answers);
    return Object.keys(payload).length === 0 ? undefined : { actor: "human", payload };
  }
  if (request.kind === "approval") {
    const approved = resolveApproval(request.gate.id, approvals);
    return approved === undefined ? undefined : { actor: "human", payload: approved };
  }
  const payload = answers[request.id];
  if (payload !== undefined) {
    return { actor: "agent", payload };
  }
  const agentRuntime = loadAgentRuntime ? await loadAgentRuntime() : undefined;
  return agentRuntime ? await agentRuntime.resolve(request) : undefined;
}

async function resolveInteractiveRequest(
  request: ResolutionRequest,
  io: CliIo,
  answers: Readonly<Record<string, unknown>> = {},
  approvals?: boolean | Readonly<Record<string, boolean>>,
  loadAgentRuntime?: () => Promise<CliAgentRuntime | undefined>,
): Promise<ResolutionResponse | undefined> {
  if (request.kind === "input") {
    return {
      actor: "human",
      payload: await askQuestions(request.questions, io, answers),
    };
  }
  if (request.kind === "approval") {
    const provided = resolveApproval(request.gate.id, approvals);
    return {
      actor: "human",
      payload: provided ?? await approveGate(request.gate, io, approvals),
    };
  }
  const payload = answers[request.id];
  if (payload !== undefined) {
    return { actor: "agent", payload };
  }
  const agentRuntime = loadAgentRuntime ? await loadAgentRuntime() : undefined;
  return agentRuntime ? await agentRuntime.resolve(request) : undefined;
}

function resolveApproval(
  gateId: string,
  approvals?: boolean | Readonly<Record<string, boolean>>,
): boolean | undefined {
  if (typeof approvals === "boolean") {
    return approvals;
  }
  return approvals?.[gateId];
}

async function askQuestions(
  questions: readonly Question[],
  io: CliIo,
  answers: Readonly<Record<string, unknown>> = {},
): Promise<Record<string, unknown>> {
  const provided = pickAnswers(questions, answers);
  const autoFilled = Object.fromEntries(
    questions
      .filter((question) => provided[question.id] === undefined && shouldAutoUseDefault(question))
      .map((question) => [question.id, inferQuestionDefault(question)])
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
  );
  const seeded = { ...provided, ...autoFilled };
  const unanswered = questions.filter((question) => seeded[question.id] === undefined);
  if (unanswered.length === 0) {
    return seeded;
  }

  const t = theme(io.stdout);
  const rl = createInterface({ input: io.stdin, output: io.stdout });
  const countLabel = unanswered.length === 1 ? "1 value" : `${unanswered.length} values`;
  io.stdout.write(`\n  ${t.yellow}◇${t.reset}  ${t.bold}input needed${t.reset}  ${t.dim}${countLabel}${t.reset}\n\n`);

  try {
    const collected: Record<string, unknown> = { ...seeded };
    for (const question of unanswered) {
      const defaultValue = inferQuestionDefault(question);
      const label = question.prompt;
      const detail = question.description && question.description !== question.prompt ? question.description : undefined;
      io.stdout.write(`  ${t.bold}${label}${t.reset}\n`);
      if (detail) {
        io.stdout.write(`  ${t.dim}${detail}${t.reset}\n`);
      }
      if (defaultValue) {
        io.stdout.write(`  ${t.dim}default${t.reset}  ${defaultValue}\n`);
      } else if (question.required) {
        io.stdout.write(`  ${t.dim}required${t.reset}\n`);
      }
      const answer = (await rl.question(`  ${t.cyan}›${t.reset} `)).trim();
      collected[question.id] = answer || defaultValue || "";
      io.stdout.write("\n");
    }
    return collected;
  } finally {
    rl.close();
  }
}

function inferQuestionDefault(question: Question): string | undefined {
  const label = `${question.id} ${question.prompt} ${question.description ?? ""}`.toLowerCase();
  if (question.id === "project" || /project\s+root|repo\s+root|working\s+directory/.test(label)) {
    return process.cwd();
  }
  return undefined;
}

function shouldAutoUseDefault(question: Question): boolean {
  const label = `${question.id} ${question.prompt} ${question.description ?? ""}`.toLowerCase();
  return question.id === "project" || /project\s+root|repo\s+root|working\s+directory/.test(label);
}

function pickAnswers(
  questions: readonly Question[],
  answers: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    questions
      .filter((question) => answers[question.id] !== undefined)
      .map((question) => [question.id, answers[question.id]]),
  );
}

function validateCallerApprovals(value: unknown): boolean | Readonly<Record<string, boolean>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (!isRecord(value)) {
    throw new Error("--answers approvals field must be a boolean or object.");
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, approval]) => {
      if (typeof approval !== "boolean") {
        throw new Error(`--answers approvals.${key} must be a boolean.`);
      }
      return [key, approval];
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
