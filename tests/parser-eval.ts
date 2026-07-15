import { spawnSync } from "node:child_process";

import { resolveRunxBinary } from "./runx-binary.js";

export type JsonRecord = Record<string, unknown>;

export interface ValidatedSkill {
  readonly name: string;
  readonly source: SkillSource;
  readonly inputs: Record<string, unknown>;
  readonly raw: JsonRecord;
  readonly [key: string]: unknown;
}

export interface ValidatedRunnerManifest {
  readonly skill?: string;
  readonly catalog?: JsonRecord;
  readonly runners: Record<string, RunnerDefinition>;
  readonly harness?: {
    readonly cases: readonly HarnessCase[];
    readonly [key: string]: unknown;
  };
  readonly raw: {
    readonly document: JsonRecord;
    readonly raw: string;
  };
}

export interface RunnerDefinition {
  readonly name: string;
  readonly default: boolean;
  readonly source: SkillSource;
  readonly inputs: Record<string, RunnerInput>;
  readonly runtime?: unknown;
  readonly raw: JsonRecord;
  readonly [key: string]: unknown;
}

export interface RunnerInput {
  readonly required?: boolean;
  readonly [key: string]: unknown;
}

export interface SkillSource {
  readonly type: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly timeoutSeconds?: number;
  readonly graph?: ExecutionGraph;
  readonly [key: string]: unknown;
}

export interface ExecutionGraph {
  readonly name: string;
  readonly steps: readonly GraphStep[];
  readonly policy?: {
    readonly guards?: readonly GraphGuard[];
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

export interface GraphGuard {
  readonly step: string;
  readonly field: string;
  readonly equals?: unknown;
  readonly notEquals?: unknown;
  readonly [key: string]: unknown;
}

export interface GraphStep {
  readonly id: string;
  readonly label?: string;
  readonly skill?: string;
  readonly tool?: string;
  readonly run?: JsonRecord;
  readonly instructions?: string;
  readonly artifacts?: JsonRecord;
  readonly runner?: string;
  readonly inputs: JsonRecord;
  readonly context: Record<string, string>;
  readonly [key: string]: unknown;
}

export interface HarnessCase {
  readonly name: string;
  readonly runner?: string;
  readonly inputs?: unknown;
  readonly env?: unknown;
  readonly caller?: unknown;
  readonly expect?: unknown;
  readonly [key: string]: unknown;
}

type ParserRequest =
  | {
      readonly kind: "parser.validateSkillMarkdown";
      readonly markdown: string;
      readonly mode?: "strict" | "lenient";
    }
  | {
      readonly kind: "parser.validateRunnerManifestYaml";
      readonly yaml: string;
    };

const parserEvalCache = new Map<string, unknown>();

export function validateSkillMarkdown(
  markdown: string,
  options: { readonly mode?: "strict" | "lenient" } = {},
): ValidatedSkill {
  return evaluateParserRequest<ValidatedSkill>({
    kind: "parser.validateSkillMarkdown",
    markdown,
    ...(options.mode ? { mode: options.mode } : {}),
  });
}

export function validateRunnerManifestYaml(yaml: string): ValidatedRunnerManifest {
  return evaluateParserRequest<ValidatedRunnerManifest>({
    kind: "parser.validateRunnerManifestYaml",
    yaml,
  });
}

function evaluateParserRequest<T>(input: ParserRequest): T {
  const request = JSON.stringify({ input });
  const cached = parserEvalCache.get(request);
  if (cached !== undefined) {
    return cached as T;
  }

  const result = spawnSync(
    resolveRunxBinary(),
    ["parser", "eval", "--input", "-", "--json"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
      input: request,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "runx parser eval failed");
  }

  const envelope = JSON.parse(result.stdout) as {
    readonly status?: string;
    readonly result?: {
      readonly value?: unknown;
    };
  };
  if (envelope.status !== "success" || envelope.result?.value === undefined) {
    throw new Error(`runx parser eval returned an unexpected response: ${result.stdout}`);
  }
  parserEvalCache.set(request, envelope.result.value);
  return envelope.result.value as T;
}
