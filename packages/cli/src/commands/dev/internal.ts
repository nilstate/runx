import { existsSync } from "node:fs";
import path from "node:path";

import type {
  DevFixtureAssertionContract,
  DevFixtureResultContract,
} from "@runxhq/contracts";

export type FixtureAssertion = DevFixtureAssertionContract;

export type DevFixtureResult = DevFixtureResultContract;

export interface PreparedFixtureWorkspace {
  readonly root?: string;
  readonly tokens: Readonly<Record<string, string>>;
  readonly cleanup: () => Promise<void>;
}

export interface FixtureExecutionRoots {
  readonly cwd: string;
  readonly repoRoot: string;
}

export function failedFixture(
  name: string,
  lane: string,
  target: Readonly<Record<string, unknown>>,
  startedAt: number,
  assertions: readonly FixtureAssertion[],
): DevFixtureResult {
  return {
    name,
    lane,
    target,
    status: "failure",
    duration_ms: Date.now() - startedAt,
    assertions,
  };
}

export function resolveSkillDirFromRef(root: string, ref: string): string | undefined {
  const candidates = [
    path.join(root, "skills", ref),
    path.resolve(root, ref),
  ];
  return candidates.find((candidate) => existsSync(path.join(candidate, "SKILL.md")));
}

export function parseJsonMaybe(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}
