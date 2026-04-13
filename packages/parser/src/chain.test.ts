import { describe, expect, it } from "vitest";

import { ChainParseError, ChainValidationError, parseChainYaml, validateChain } from "./chain.js";

const validChain = `
name: sequential-echo
owner: runx
steps:
  - id: first
    skill: ../../skills/echo
    runner: echo-cli
    inputs:
      message: hello
    scopes:
      - filesystem:read
  - id: second
    skill: ../../skills/echo
    context:
      message: first.stdout
    retry:
      max_attempts: 2
      backoff_ms: 25
`;

describe("parseChainYaml", () => {
  it("parses chain yaml into raw IR", () => {
    const raw = parseChainYaml(validChain);

    expect(raw.document.name).toBe("sequential-echo");
    expect(raw.document.steps).toHaveLength(2);
  });

  it("fails when yaml is malformed", () => {
    expect(() => parseChainYaml("name: [unterminated")).toThrow(ChainParseError);
  });
});

describe("validateChain", () => {
  it("validates a sequential chain with explicit context edges", () => {
    const chain = validateChain(parseChainYaml(validChain));

    expect(chain.name).toBe("sequential-echo");
    expect(chain.owner).toBe("runx");
    expect(chain.steps.map((step) => step.id)).toEqual(["first", "second"]);
    expect(chain.steps[0].runner).toBe("echo-cli");
    expect(chain.steps[0].inputs).toEqual({ message: "hello" });
    expect(chain.steps[0].scopes).toEqual(["filesystem:read"]);
    expect(chain.steps[1].contextEdges).toEqual([
      {
        input: "message",
        fromStep: "first",
        output: "stdout",
      },
    ]);
    expect(chain.steps[1].retry).toEqual({ maxAttempts: 2, backoffMs: 25 });
    expect(chain.steps[1].mutating).toBe(false);
  });

  it("validates inline run steps without forcing them into skill files", () => {
    const chain = validateChain(
      parseChainYaml(`
name: evolve-like
steps:
  - id: preflight
    run:
      type: cli-tool
      command: node
      args: ["-e", "process.stdout.write('{}')"]
    artifacts:
      named_emits:
        repo_profile: repo_profile
  - id: plan
    run:
      type: agent-step
      agent: builder
      task: plan
    instructions: use the parent skill environment
    context:
      repo_profile: preflight.repo_profile
`),
    );

    expect(chain.steps[0]).toMatchObject({
      id: "preflight",
      run: {
        type: "cli-tool",
      },
      skill: undefined,
    });
    expect(chain.steps[1]).toMatchObject({
      id: "plan",
      run: {
        type: "agent-step",
        agent: "builder",
        task: "plan",
      },
      instructions: "use the parent skill environment",
    });
  });

  it("validates tool steps and allowed tool declarations for agent steps", () => {
    const chain = validateChain(
      parseChainYaml(`
name: tool-aware
steps:
  - id: readme
    tool: fs.read
    inputs:
      path: README.md
  - id: plan
    run:
      type: agent-step
      agent: builder
      task: plan
    allowed_tools:
      - fs.read
      - git.status
    context:
      readme: readme.stdout
`),
    );

    expect(chain.steps[0]).toMatchObject({
      id: "readme",
      tool: "fs.read",
      skill: undefined,
      run: undefined,
    });
    expect(chain.steps[1]?.allowedTools).toEqual(["fs.read", "git.status"]);
  });

  it("validates mutating retry idempotency metadata", () => {
    const chain = validateChain(
      parseChainYaml(`
name: retry-idempotency
steps:
  - id: mutate
    skill: ../../skills/echo
    mutation: mutating
    idempotency_key: "{{request_id}}"
    retry:
      max_attempts: 2
      backoff_ms: 50
`),
    );

    expect(chain.steps[0]).toMatchObject({
      mutating: true,
      idempotencyKey: "{{request_id}}",
      retry: {
        maxAttempts: 2,
        backoffMs: 50,
      },
    });
  });

  it("rejects invalid retry and idempotency declarations", () => {
    expect(() =>
      validateChain(
        parseChainYaml(`
name: bad-retry
steps:
  - id: mutate
    skill: ../../skills/echo
    mutation: mutating
    idempotency_key: ""
    retry:
      max_attempts: 0
`),
      ),
    ).toThrow(ChainValidationError);
  });

  it("fails when a step id is missing", () => {
    expect(() =>
      validateChain(
        parseChainYaml(`
name: bad
steps:
  - skill: ../../skills/echo
`),
      ),
    ).toThrow(ChainValidationError);
  });

  it("fails when runner selector embeds a profile instead of a name", () => {
    expect(() =>
      validateChain(
        parseChainYaml(`
name: bad-runner
steps:
  - id: first
    skill: ../../skills/echo
    runner:
      type: cli-tool
      command: node
`),
      ),
    ).toThrow(ChainValidationError);
  });

  it("fails when a context edge references an unknown step", () => {
    expect(() =>
      validateChain(
        parseChainYaml(`
name: bad
steps:
  - id: first
    skill: ../../skills/echo
    context:
      message: missing.stdout
`),
      ),
    ).toThrow(ChainValidationError);
  });

  it("fails when a context edge references a later step", () => {
    expect(() =>
      validateChain(
        parseChainYaml(`
name: bad
steps:
  - id: first
    skill: ../../skills/echo
    context:
      message: second.stdout
  - id: second
    skill: ../../skills/echo
`),
      ),
    ).toThrow(ChainValidationError);
  });

  it("validates fanout groups with structured gates", () => {
    const chain = validateChain(
      parseChainYaml(`
name: fanout
fanout:
  groups:
    advisors:
      strategy: quorum
      min_success: 2
      on_branch_failure: continue
      threshold_gates:
        - step: risk
          field: risk_score
          above: 0.8
          action: pause
      conflict_gates:
        - field: recommendation
          steps: [market, risk]
          action: escalate
steps:
  - id: market
    mode: fanout
    fanout_group: advisors
    skill: ../../skills/echo
  - id: risk
    mode: fanout
    fanout_group: advisors
    skill: ../../skills/echo
  - id: finance
    mode: fanout
    fanout_group: advisors
    skill: ../../skills/echo
`),
    );

    expect(chain.fanoutGroups.advisors).toMatchObject({
      groupId: "advisors",
      strategy: "quorum",
      minSuccess: 2,
      onBranchFailure: "continue",
    });
    expect(chain.fanoutGroups.advisors?.thresholdGates).toEqual([
      {
        step: "risk",
        field: "risk_score",
        above: 0.8,
        action: "pause",
      },
    ]);
    expect(chain.fanoutGroups.advisors?.conflictGates).toEqual([
      {
        field: "recommendation",
        steps: ["market", "risk"],
        action: "escalate",
      },
    ]);
    expect(chain.steps.map((step) => step.fanoutGroup)).toEqual(["advisors", "advisors", "advisors"]);
  });

  it("fails when fanout declaration is malformed", () => {
    expect(() =>
      validateChain(
        parseChainYaml(`
name: fanout
fanout: true
steps:
  - id: first
    skill: ../../skills/echo
`),
      ),
    ).toThrow(ChainValidationError);
  });

  it("fails when fanout mode omits its group", () => {
    expect(() =>
      validateChain(
        parseChainYaml(`
name: fanout
fanout:
  groups:
    advisors:
      strategy: all
steps:
  - id: first
    skill: ../../skills/echo
    mode: fanout
`),
      ),
    ).toThrow(ChainValidationError);
  });

  it("fails when fanout policy tries to evaluate prose", () => {
    expect(() =>
      validateChain(
        parseChainYaml(`
name: fanout
fanout:
  groups:
    advisors:
      threshold_gates:
        - step: risk
          field: risk_score
          above: 0.8
          action: pause
          sentiment: negative
steps:
  - id: risk
    mode: fanout
    fanout_group: advisors
    skill: ../../skills/echo
`),
      ),
    ).toThrow(ChainValidationError);
  });
});
