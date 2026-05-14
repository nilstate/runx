import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readCallerInputFile } from "../packages/cli/src/callers.js";

async function writeAnswersFile(dir: string, name: string, body: unknown): Promise<string> {
  const filePath = path.join(dir, name);
  await writeFile(filePath, JSON.stringify(body));
  return filePath;
}

describe("readCallerInputFile shape contract", () => {
  it("flat shape: top-level keys are treated as answers when no answers/approvals field is present", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-answers-flat-"));
    try {
      const filePath = await writeAnswersFile(tempDir, "answers.json", {
        "agent_step.foo.output": { result: 42 },
      });
      const result = await readCallerInputFile(filePath);
      expect(result.answers).toEqual({ "agent_step.foo.output": { result: 42 } });
      expect(result.approvals).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("nested shape: answers and approvals fields parse correctly", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-answers-nested-"));
    try {
      const filePath = await writeAnswersFile(tempDir, "answers.json", {
        answers: { "agent_step.foo.output": { result: 42 } },
        approvals: { "gate.foo": true },
      });
      const result = await readCallerInputFile(filePath);
      expect(result.answers).toEqual({ "agent_step.foo.output": { result: 42 } });
      expect(result.approvals).toEqual({ "gate.foo": true });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("mixed shape: throws a descriptive error naming the offending top-level keys", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-answers-mixed-"));
    try {
      const filePath = await writeAnswersFile(tempDir, "answers.json", {
        "agent_step.foo.output": { result: 42 },
        approvals: { "gate.foo": true },
      });
      await expect(readCallerInputFile(filePath)).rejects.toThrow(/agent_step\.foo\.output/);
      await expect(readCallerInputFile(filePath)).rejects.toThrow(/flat|nested/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("nested shape with answers field only: works without approvals", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-answers-nested-no-approvals-"));
    try {
      const filePath = await writeAnswersFile(tempDir, "answers.json", {
        answers: { "agent_step.foo.output": { result: 42 } },
      });
      const result = await readCallerInputFile(filePath);
      expect(result.answers).toEqual({ "agent_step.foo.output": { result: 42 } });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
