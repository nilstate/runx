import { describe, expect, it } from "vitest";

import {
  SkillParseError,
  SkillValidationError,
  extractSkillQualityProfile,
  parseRunnerManifestYaml,
  parseSkillMarkdown,
  parseToolManifestYaml,
  validateRunnerManifest,
  validateSkill,
  validateToolManifest,
} from "./index.js";

const validSkill = `---
name: echo
description: Echo a message
source:
  type: cli-tool
  command: node
  args:
    - -e
    - "process.stdout.write(process.argv[1] ?? '')"
  timeout_seconds: 10
inputs:
  message:
    type: string
    required: true
    description: Message to echo
runx:
  input_resolution:
    required:
      - message
---
# Echo

Print a message.
`;

describe("parseSkillMarkdown", () => {
  it("parses frontmatter and body into raw IR", () => {
    const raw = parseSkillMarkdown(validSkill);

    expect(raw.frontmatter.name).toBe("echo");
    expect(raw.body).toContain("Print a message.");
  });

  it("fails when frontmatter is missing", () => {
    expect(() => parseSkillMarkdown("# Echo")).toThrow(SkillParseError);
  });

  it("fails when frontmatter YAML is malformed", () => {
    expect(() =>
      parseSkillMarkdown(`---
name: echo
source: [unterminated
---
body
`),
    ).toThrow(SkillParseError);
  });
});

describe("validateSkill", () => {
  it("defaults portable skills to the agent runner", () => {
    const skill = validateSkill(
      parseSkillMarkdown(`---
name: portable
description: A portable marketplace skill.
---
# Standard Only

Follow the instructions.
`),
    );

    expect(skill.name).toBe("portable");
    expect(skill.source).toMatchObject({
      type: "agent",
      args: [],
      raw: { type: "agent" },
    });
  });

  it("validates a cli-tool skill", () => {
    const skill = validateSkill(parseSkillMarkdown(validSkill));

    expect(skill.name).toBe("echo");
    expect(skill.description).toBe("Echo a message");
    expect(skill.source).toMatchObject({
      type: "cli-tool",
      command: "node",
      args: ["-e", "process.stdout.write(process.argv[1] ?? '')"],
      timeoutSeconds: 10,
    });
    expect(skill.inputs.message).toMatchObject({
      type: "string",
      required: true,
      description: "Message to echo",
    });
    expect(skill.runx).toEqual({
      input_resolution: {
        required: ["message"],
      },
    });
  });

  it("extracts the Quality Profile section as prompt contract", () => {
    const skill = validateSkill(
      parseSkillMarkdown(`---
name: quality-demo
---
# Quality Demo

Instructions before the contract.

## Quality Profile

- Purpose: produce a maintainer-grade answer.
- Evidence bar: cite concrete repo evidence.

## Outputs

- answer
`),
    );

    expect(skill.qualityProfile).toEqual({
      heading: "Quality Profile",
      content: "- Purpose: produce a maintainer-grade answer.\n- Evidence bar: cite concrete repo evidence.",
    });
    expect(extractSkillQualityProfile(skill.body)?.content).toContain("maintainer-grade");
  });

  it("validates cli-tool sandboprofile metadata from runx", () => {
    const skill = validateSkill(
      parseSkillMarkdown(`---
name: sandboxed
source:
  type: cli-tool
  command: node
  timeout_seconds: 10
runx:
  sandbox:
    profile: workspace-write
    cwd_policy: workspace
    env_allowlist:
      - PATH
    network: false
    writable_paths:
      - "{{output_path}}"
---
Sandboxed.
`),
    );

    expect(skill.source.sandbox).toEqual({
      profile: "workspace-write",
      cwdPolicy: "workspace",
      envAllowlist: ["PATH"],
      network: false,
      writablePaths: ["{{output_path}}"],
      raw: {
        profile: "workspace-write",
        cwd_policy: "workspace",
        env_allowlist: ["PATH"],
        network: false,
        writable_paths: ["{{output_path}}"],
      },
    });
  });

  it("validates skill retry, mutation, and idempotency metadata", () => {
    const skill = validateSkill(
      parseSkillMarkdown(`---
name: mutating-skill
source:
  type: cli-tool
  command: node
retry:
  max_attempts: 2
idempotency:
  key: "{{request_id}}"
risk:
  mutating: true
---
Mutating.
`),
    );

    expect(skill.retry).toEqual({ maxAttempts: 2 });
    expect(skill.idempotency).toEqual({ key: "{{request_id}}" });
    expect(skill.mutating).toBe(true);
  });

  it("rejects invalid sandbox profiles", () => {
    expect(() =>
      validateSkill(
        parseSkillMarkdown(`---
name: bad-sandbox
source:
  type: cli-tool
  command: node
  sandbox:
    profile: pretend-secure
---
Bad.
`),
      ),
    ).toThrow("sandbox.profile must be readonly, workspace-write, network, or unrestricted-local-dev");
  });

  it("validates mcp source metadata", () => {
    const raw = parseSkillMarkdown(`---
name: mcp-echo
source:
  type: mcp
  server:
    command: node
    args:
      - ./server.js
  tool: echo
  arguments:
    message: "{{message}}"
inputs:
  message:
    required: true
---
Echo through MCP.
`);

    const skill = validateSkill(raw);

    expect(skill.source.type).toBe("mcp");
    expect(skill.source.server?.command).toBe("node");
    expect(skill.source.tool).toBe("echo");
    expect(skill.source.arguments?.message).toBe("{{message}}");
  });

  it("validates explicit agent-step source metadata", () => {
    const skill = validateSkill(
      parseSkillMarkdown(`---
name: work-plan
source:
  type: agent-step
  agent: codex
  task: work-plan
  outputs:
    draft_spec: string
inputs:
  objective:
    type: string
    required: true
---
Decompose the objective.
`),
    );

    expect(skill.source).toMatchObject({
      type: "agent-step",
      agent: "codex",
      task: "work-plan",
      outputs: { draft_spec: "string" },
    });
  });

  it("validates allowed_tools metadata on agent-mediated skills", () => {
    const skill = validateSkill(
      parseSkillMarkdown(`---
name: governed-agent
runx:
  allowed_tools:
    - fs.read
    - git.status
---
Governed agent.
`),
    );

    expect(skill.allowedTools).toEqual(["fs.read", "git.status"]);
  });

  it("projects optional execution semantics from skill frontmatter", () => {
    const skill = validateSkill(
      parseSkillMarkdown(`---
name: runtime-hints
source:
  type: cli-tool
  command: node
execution:
  disposition: observing
  outcome_state: pending
  input_context:
    capture: true
    max_bytes: 128
  surface_refs:
    - type: issue
      uri: github://owner/repo/issues/7
---
Runtime hints.
`),
    );

    expect(skill.execution).toEqual({
      disposition: "observing",
      outcome_state: "pending",
      input_context: {
        capture: true,
        max_bytes: 128,
        source: undefined,
        snapshot: undefined,
      },
      surface_refs: [{ type: "issue", uri: "github://owner/repo/issues/7", label: undefined }],
      evidence_refs: undefined,
      outcome: undefined,
    });
  });

  it("validates a2a source metadata", () => {
    const skill = validateSkill(
      parseSkillMarkdown(`---
name: a2a-echo
source:
  type: a2a
  agent_card_url: fixture://echo-agent
  agent_identity: echo-agent
  task: echo
  arguments:
    message: "{{message}}"
inputs:
  message:
    required: true
---
Echo through A2A.
`),
    );

    expect(skill.source).toMatchObject({
      type: "a2a",
      agentCardUrl: "fixture://echo-agent",
      agentIdentity: "echo-agent",
      task: "echo",
      arguments: { message: "{{message}}" },
    });
  });

  it("rejects a2a source metadata without an agent card URL", () => {
    expect(() =>
      validateSkill(
        parseSkillMarkdown(`---
name: bad-a2a
source:
  type: a2a
  task: echo
---
Bad.
`),
      ),
    ).toThrow(SkillValidationError);
  });

  it("validates explicit harness-hook source metadata", () => {
    const skill = validateSkill(
      parseSkillMarkdown(`---
name: harness-review
source:
  type: harness-hook
  hook: review-receipt
  outputs:
    verdict: string
inputs:
  receipt_id:
    type: string
    required: true
---
Review a receipt in a deterministic harness.
`),
    );

    expect(skill.source).toMatchObject({
      type: "harness-hook",
      hook: "review-receipt",
      outputs: { verdict: "string" },
    });
  });

  it("rejects helper-script declarations hidden behind agent or harness source types", () => {
    expect(() =>
      validateSkill(
        parseSkillMarkdown(`---
name: hidden-helper
source:
  type: harness-hook
  hook: review-receipt
  command: node
  args:
    - ./repo-local-helper.mjs
---
Invalid.
`),
      ),
    ).toThrow("harness-hook sources must not declare source.command or source.args");
  });

  it("accepts portable skills in lenient mode", () => {
    const raw = parseSkillMarkdown(`---
name: portable
---
Body
`);

    const skill = validateSkill(raw, { mode: "lenient" });
    expect(skill.runx).toBeUndefined();
    expect(skill.source.type).toBe("agent");
  });

  it("fails strict validation for malformed runprofile metadata", () => {
    const raw = parseSkillMarkdown(`---
name: bad-runx
source:
  type: cli-tool
  command: echo
runx: invalid
---
Body
`);

    expect(() => validateSkill(raw, { mode: "strict" })).toThrow(SkillValidationError);
  });

  it("fails when cli-tool source command is missing", () => {
    const raw = parseSkillMarkdown(`---
name: missing-command
source:
  type: cli-tool
---
Body
`);

    expect(() => validateSkill(raw)).toThrow(SkillValidationError);
  });

  it("fails when mcp tool is missing", () => {
    const raw = parseSkillMarkdown(`---
name: bad-mcp
source:
  type: mcp
  server:
    command: node
---
Bad MCP skill.
`);

    expect(() => validateSkill(raw)).toThrow(SkillValidationError);
  });
});

describe("validateToolManifest", () => {
  it("validates a deterministic tool manifest", () => {
    const tool = validateToolManifest(
      parseToolManifestYaml(`name: fs.read
description: Read a file.
source:
  type: cli-tool
  command: node
  args:
    - -e
    - "process.stdout.write('ok')"
inputs:
  path:
    type: string
    required: true
scopes:
  - fs.read
runx:
  artifacts:
    wrap_as: file_read
`),
    );

    expect(tool).toMatchObject({
      name: "fs.read",
      source: {
        type: "cli-tool",
        command: "node",
      },
      scopes: ["fs.read"],
      artifacts: {
        wrapAs: "file_read",
      },
    });
  });

  it("rejects non-deterministic tool manifests", () => {
    expect(() =>
      validateToolManifest(
        parseToolManifestYaml(`name: bad.tool
source:
  type: agent-step
  agent: codex
  task: think
`),
      ),
    ).toThrow("source.type must be one of cli-tool, mcp, a2a, or catalog for tool manifests.");
  });
});

describe("validateRunnerManifest", () => {
  it("validates A2A runner metadata outside the standard skill file", () => {
    const manifest = validateRunnerManifest(
      parseRunnerManifestYaml(`skill: a2a-echo
catalog:
  kind: skill
  audience: public
runners:
  fixture-a2a:
    type: a2a
    agent_card_url: fixture://echo-agent
    agent_identity: echo-agent
    task: echo
    arguments:
      message: "{{message}}"
    inputs:
      message:
        required: true
`),
    );

    expect(manifest.skill).toBe("a2a-echo");
    expect(manifest.catalog).toEqual({
      kind: "skill",
      audience: "public",
      visibility: "public",
    });
    expect(manifest.runners["fixture-a2a"]).toMatchObject({
      name: "fixture-a2a",
      source: {
        type: "a2a",
        agentCardUrl: "fixture://echo-agent",
        agentIdentity: "echo-agent",
        task: "echo",
      },
      inputs: {
        message: {
          required: true,
        },
      },
    });
  });

  it("validates optional inline harness cases", () => {
    const manifest = validateRunnerManifest(
      parseRunnerManifestYaml(`skill: evolve
catalog:
  kind: chain
  audience: operator
  visibility: private
runners:
  evolve:
    type: agent
harness:
  cases:
    - name: plan-only
      runner: evolve
      inputs:
        objective: add release notes
      caller:
        approvals:
          evolve.plan.approval: true
      expect:
        status: success
        receipt:
          kind: graph_execution
`),
    );

    expect(manifest.harness?.cases).toEqual([
      {
        name: "plan-only",
        runner: "evolve",
        inputs: { objective: "add release notes" },
        env: {},
        caller: {
          approvals: {
            "evolve.plan.approval": true,
          },
        },
        expect: {
          status: "success",
          receipt: {
            kind: "graph_execution",
          },
        },
      },
    ]);
  });

  it("rejects invalid catalog metadata", () => {
    expect(() =>
      validateRunnerManifest(
        parseRunnerManifestYaml(`skill: bad-catalog
catalog:
  kind: workflow
  audience: public
runners:
  default:
    type: agent
`),
      ),
    ).toThrow("catalog.kind must be skill or chain.");
  });

  it("projects optional execution semantics from runner manifests", () => {
    const manifest = validateRunnerManifest(
      parseRunnerManifestYaml(`skill: runtime-hints
runners:
  default:
    type: cli-tool
    command: node
    execution:
      disposition: observing
      outcome_state: pending
      evidence_refs:
        - type: log
          uri: file://receipt-log
`),
    );

    expect(manifest.runners.default?.execution).toEqual({
      disposition: "observing",
      outcome_state: "pending",
      evidence_refs: [{ type: "log", uri: "file://receipt-log", label: undefined }],
      input_context: undefined,
      outcome: undefined,
      surface_refs: undefined,
    });
  });

  it("validates post-run reflect policy metadata on runners", () => {
    const manifest = validateRunnerManifest(
      parseRunnerManifestYaml(`skill: reflectable
runners:
  default:
    type: agent-step
    agent: reviewer
    task: reflectable
    runx:
      post_run:
        reflect: auto
`),
    );

    expect(manifest.runners.default?.runx).toEqual({
      post_run: {
        reflect: "auto",
      },
    });
  });

  it("rejects invalid post-run reflect policy metadata on runners", () => {
    expect(() =>
      validateRunnerManifest(
        parseRunnerManifestYaml(`skill: reflectable
runners:
  default:
    type: agent-step
    agent: reviewer
    task: reflectable
    runx:
      post_run:
        reflect: sometimes
`),
      ),
    ).toThrow("runners.default.runx.post_run.reflect must be auto, always, or never.");
  });

  it("rejects invalid inline harness approval values", () => {
    expect(() =>
      validateRunnerManifest(
        parseRunnerManifestYaml(`skill: evolve
runners:
  evolve:
    type: agent
harness:
  cases:
    - name: bad
      caller:
        approvals:
          evolve.plan.approval: yes
      expect:
        status: success
`),
      ),
    ).toThrow("harness.cases[0].caller.approvals.evolve.plan.approval must be a boolean.");
  });

  it("rejects inline harness cases that reference unknown runners", () => {
    expect(() =>
      validateRunnerManifest(
        parseRunnerManifestYaml(`skill: evolve
runners:
  evolve:
    type: agent
harness:
  cases:
    - name: missing-runner
      runner: missing
      expect:
        status: success
`),
      ),
    ).toThrow("harness.cases runner missing is not declared in runners.");
  });
});
