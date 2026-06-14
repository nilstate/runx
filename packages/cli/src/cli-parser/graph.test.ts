import { describe, expect, it } from "vitest";

import { parseGraphYaml, validateGraph } from "./graph.js";

function validate(source: string) {
  return validateGraph(parseGraphYaml(source));
}

describe("CLI graph parser", () => {
  it("accepts context skills on agent-task steps", () => {
    const graph = validate(`
name: context-skills
steps:
  - id: apply_taste
    run:
      type: agent-task
      agent: builder
      task: apply taste
    context_skills:
      - registry:runx/taste-profile@1.0.0
`);

    expect(graph.steps[0]?.contextSkills).toEqual(["registry:runx/taste-profile@1.0.0"]);
  });

  it("rejects context skills on non-agent run steps", () => {
    expect(() =>
      validate(`
name: bad-context-skills
steps:
  - id: inspect
    run:
      type: cli-tool
      command: node
    context_skills:
      - registry:runx/taste-profile@1.0.0
`),
    ).toThrow(/context_skills is only valid/);
  });

  it("rejects legacy stage steps even when a valid target is also present", () => {
    expect(() =>
      validate(`
name: stage-graph
steps:
  - id: quote
    stage: pay-quote
    skill: graph/pay-quote
`),
    ).toThrow(/steps\.0\.stage is not supported/);
  });
});
