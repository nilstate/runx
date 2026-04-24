import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../packages/cli/src/index.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

describe("remote registry search", () => {
  it("searches the hosted public registry without a local registry dir", async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    globalThis.fetch = vi.fn(async (input) => {
      expect(String(input)).toContain("/v1/skills?q=sourcey");
      return new Response(JSON.stringify({
        status: "success",
        total: 1,
        skills: [
          {
            skill_id: "acme/sourcey",
            owner: "acme",
            name: "sourcey",
            description: "Generate docs from repo evidence.",
            version: "1.0.0",
            source_type: "agent",
            profile_mode: "profiled",
            runner_names: ["agent", "sourcey"],
            required_scopes: [],
            tags: ["docs"],
            trust_tier: "community",
            trust_signals: [],
            install_command: "runx add acme/sourcey@1.0.0 --registry https://runx.example.test",
            run_command: "runx sourcey",
          },
        ],
      }), { status: 200 });
    }) as typeof fetch;

    const exitCode = await runCli(
      ["skill", "search", "sourcey", "--json"],
      { stdin: process.stdin, stdout, stderr },
      {
        ...process.env,
        RUNX_CWD: process.cwd(),
        RUNX_REGISTRY_URL: "https://runx.example.test",
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.contents()).toBe("");
    expect(JSON.parse(stdout.contents())).toMatchObject({
      status: "success",
      query: "sourcey",
      results: [
        {
          skill_id: "acme/sourcey",
          source: "runx-registry",
          source_label: "runx registry",
          trust_tier: "community",
          profile_mode: "profiled",
          runner_names: ["agent", "sourcey"],
          add_command: "runx add acme/sourcey@1.0.0 --registry https://runx.example.test",
        },
      ],
    });
  });
});

function createMemoryStream(): NodeJS.WriteStream & { contents: () => string } {
  let buffer = "";
  return {
    write: (chunk: string | Uint8Array) => {
      buffer += chunk.toString();
      return true;
    },
    contents: () => buffer,
  } as NodeJS.WriteStream & { contents: () => string };
}
