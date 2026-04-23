import path from "node:path";

import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import { artifact, definePacket, defineTool, failure, firstNonEmptyString, prune, resolveInsideRepo, resolveRepoRoot, stringInput } from "./index.js";

describe("@runxhq/authoring", () => {
  it("defines packets as durable schema objects", () => {
    const packet = definePacket({
      id: "runx.docs.scan.v1",
      schema: Type.Object({
        status: Type.String(),
      }),
    });

    expect(packet.id).toBe("runx.docs.scan.v1");
    expect(packet.schema.type).toBe("object");
  });

  it("runs tools directly with materialized inputs", async () => {
    const tool = defineTool({
      name: "demo.echo",
      schema: "demo.echo.v1",
      inputs: {
        message: stringInput(),
      },
      run({ inputs }) {
        return { message: inputs.message };
      },
    });

    await expect(tool.runWith({ message: "hello" })).resolves.toEqual({
      schema: "demo.echo.v1",
      data: { message: "hello" },
    });
  });

  it("uses output.packet as the emitted artifact schema", async () => {
    const tool = defineTool({
      name: "demo.packet_echo",
      output: {
        packet: "demo.echo.v1",
        wrap_as: "echo_packet",
      },
      inputs: {
        message: stringInput(),
      },
      run({ inputs }) {
        return { message: inputs.message };
      },
    });

    await expect(tool.runWith({ message: "hello" })).resolves.toEqual({
      schema: "demo.echo.v1",
      data: { message: "hello" },
    });
  });

  it("preserves structured failures", async () => {
    const tool = defineTool({
      name: "demo.fail",
      run() {
        return failure({ error: { code: "invalid_input" } }, { exitCode: 2, stderr: "bad input" });
      },
    });

    await expect(tool.runWith()).resolves.toMatchObject({
      output: { error: { code: "invalid_input" } },
      exitCode: 2,
      stderr: "bad input",
    });
  });

  it("unwraps artifact envelopes", async () => {
    const tool = defineTool({
      name: "demo.artifact",
      inputs: {
        packet: artifact<{ value: string }>(),
      },
      run({ inputs }) {
        return inputs.packet;
      },
    });

    await expect(tool.runWith({ packet: { schema: "demo.packet.v1", data: { value: "ok" } } })).resolves.toEqual({
      value: "ok",
    });
  });

  it("preserves input descriptions and richer output metadata for manifest generation", () => {
    const tool = defineTool({
      name: "demo.meta",
      inputs: {
        message: stringInput({ description: "Message to echo.", default: "hello" }),
        packet: artifact({ optional: true, description: "Optional packet input." }),
      },
      output: {
        named_emits: {
          draft_pull_request: "draft_pull_request_packet",
        },
        outputs: {
          draft_pull_request: {
            packet: "runx.outbox.draft_pull_request.v1",
          },
        },
      },
      run() {
        return {};
      },
    });

    expect(tool.inputs?.message.manifest).toMatchObject({
      type: "string",
      description: "Message to echo.",
      default: "hello",
    });
    expect(tool.inputs?.packet.manifest).toMatchObject({
      type: "json",
      artifact: true,
      description: "Optional packet input.",
    });
    expect(tool.output).toMatchObject({
      named_emits: {
        draft_pull_request: "draft_pull_request_packet",
      },
      outputs: {
        draft_pull_request: {
          packet: "runx.outbox.draft_pull_request.v1",
        },
      },
    });
  });

  it("exports shared authoring helpers for built-in and project-local tools", () => {
    expect(firstNonEmptyString("", undefined, " docs ")).toBe("docs");
    expect(prune({ keep: "yes", drop: undefined, empty: [], nested: { value: undefined } })).toEqual({ keep: "yes" });
    expect(resolveRepoRoot({ repo_root: "repo" }, { RUNX_CWD: "/tmp/project" } as NodeJS.ProcessEnv)).toBe(
      path.resolve("repo"),
    );
    expect(() => resolveInsideRepo("/tmp/repo", "../escape")).toThrow(/escapes repo_root/);
  });
});
