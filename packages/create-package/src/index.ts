#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const createPackagePackage = "@runxhq/create-package";

export interface ScaffoldRunxPackageOptions {
  readonly name: string;
  readonly directory: string;
}

export async function scaffoldRunxPackage(options: ScaffoldRunxPackageOptions): Promise<void> {
  const name = sanitizePackageName(options.name);
  const root = path.resolve(options.directory);
  const toolSource = `import { defineTool, stringInput } from "@runxhq/authoring";

export default defineTool({
  name: "docs.echo",
  version: "0.1.0",
  description: "Echo a docs message.",
  inputs: {
    message: stringInput({ default: "hello" }),
  },
  output: {
    packet: "${name}.echo.v1",
    wrap_as: "echo_packet",
  },
  scopes: ["docs.read"],
  run({ inputs }) {
    return { message: inputs.message };
  },
});
`;
  const toolRuntime = `const inputs = JSON.parse(process.env.RUNX_INPUTS_JSON || "{}");
process.stdout.write(JSON.stringify({ schema: "${name}.echo.v1", data: { message: String(inputs.message || "hello") } }));
`;
  const toolInputs = {
    message: { type: "string", required: false, default: "hello" },
  };
  const toolOutput = { packet: `${name}.echo.v1`, wrap_as: "echo_packet" };
  const toolRunx = { artifacts: { wrap_as: "echo_packet" } };
  const sourceHash = sha256ToolSourceContents({
    "src/index.ts": toolSource,
    "run.mjs": toolRuntime,
  });
  const schemaHash = sha256Stable({
    inputs: toolInputs,
    output: toolOutput,
    artifacts: toolRunx.artifacts,
  });
  const agentFixture = {
    target: { kind: "skill", ref: "." },
    inputs: { message: "hello" },
    agent: { mode: "replay" },
    expect: {
      status: "success",
      outputs: {
        echo_packet: {
          matches_packet: `${name}.echo.v1`,
        },
      },
    },
  };
  await mkdir(root, { recursive: true });
  await Promise.all([
    write(root, "package.json", JSON.stringify({
      name,
      version: "0.1.0",
      type: "module",
      scripts: {
        "runx:list": "runx list --json",
        "runx:doctor": "runx doctor --json",
        "runx:dev": "runx dev --lane deterministic --json",
      },
      runx: {
        packets: ["./dist/packets/*.schema.json"],
      },
      devDependencies: {
        "@runxhq/authoring": "^0.0.0",
        "@runxhq/cli": "^0.4.1",
        "tsx": "^4.20.6",
      },
    }, null, 2)),
    write(root, "README.md", `# ${name}

Runx authoring package — composable skills governed by typed contracts.

## Layout

- **\`SKILL.md\`** — Anthropic-standard skill description. Read by humans and agents.
- **\`X.yaml\`** — runx execution profile. The **X** stands for **execution**. It layers on top of \`SKILL.md\` to declare runners, scopes, allowed tools, chain topology, and packet expectations.
- **\`src/packets/\`** — typed packet contracts (TypeBox). Source of truth for shapes flowing between steps.
- **\`tools/\`** — deterministic implementation units. Each tool authored with \`defineTool\`, built into \`manifest.json\` + \`run.mjs\`.
- **\`fixtures/\`** — examples and tests. Three lanes: deterministic, agent (replay or real), repo-integration.

## Authoring loop

\`\`\`bash
pnpm runx:list      # discover what is in this package
pnpm runx:doctor    # validate authoring artifacts
pnpm runx:dev       # run deterministic fixtures
\`\`\`

## Working with this package

Edit the tool source in \`tools/docs/echo/src/index.ts\`, then run \`runx tool build --all\` to regenerate \`manifest.json\` and \`run.mjs\`. Add fixtures in \`tools/<name>/fixtures/\` to lock behaviour.

Packet IDs are immutable. Schema changes mean a new packet ID (\`echo.v2\`), not an in-place edit of \`echo.v1\`.
`),
    write(root, "SKILL.md", `---\nname: ${name}\ndescription: Scaffolded runx skill package.\n---\n\nUse this skill to demonstrate a governed runx authoring package.\n`),
    write(root, "X.yaml", `skill: ${name}\n\nrunners:\n  default:\n    default: true\n    type: chain\n    inputs:\n      message:\n        type: string\n        required: false\n        default: hello\n    chain:\n      name: ${name}\n      steps:\n        - id: echo\n          tool: docs.echo\n          inputs:\n            message: inputs.message\n`),
    write(root, "src/packets/echo.ts", `import { definePacket, t } from "@runxhq/authoring";\n\nexport const EchoPacket = definePacket({\n  id: "${name}.echo.v1",\n  schema: t.Object({\n    message: t.String(),\n  }),\n});\n`),
    write(root, "dist/packets/echo.v1.schema.json", JSON.stringify({
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": `https://schemas.runx.dev/${name.replace(/[^a-z0-9]+/gi, "/")}/echo/v1.json`,
      "x-runx-packet-id": `${name}.echo.v1`,
      type: "object",
      required: ["message"],
      properties: {
        message: { type: "string" },
      },
      additionalProperties: false,
    }, null, 2)),
    write(root, "tools/docs/echo/src/index.ts", toolSource),
    write(root, "tools/docs/echo/run.mjs", toolRuntime),
    write(root, "tools/docs/echo/manifest.json", JSON.stringify({
      schema: "runx.tool.manifest.v1",
      name: "docs.echo",
      version: "0.1.0",
      description: "Echo a docs message.",
      source: { type: "cli-tool", command: "node", args: ["./run.mjs"] },
      runtime: { command: "node", args: ["./run.mjs"] },
      inputs: toolInputs,
      output: toolOutput,
      scopes: ["docs.read"],
      runx: toolRunx,
      source_hash: sourceHash,
      schema_hash: schemaHash,
      toolkit_version: "0.0.0",
    }, null, 2)),
    write(root, "tools/docs/echo/fixtures/basic.yaml", `name: echo-basic\nlane: deterministic\ntarget:\n  kind: tool\n  ref: docs.echo\ninputs:\n  message: hello\nexpect:\n  status: success\n  output:\n    subset:\n      schema: ${name}.echo.v1\n      data:\n        message: hello\n`),
    write(root, "fixtures/agent.yaml", `name: echo-agent-replay\nlane: agent\ntarget:\n  kind: skill\n  ref: .\ninputs:\n  message: hello\nagent:\n  mode: replay\nexpect:\n  status: success\n  outputs:\n    echo_packet:\n      matches_packet: ${name}.echo.v1\n`),
    write(root, "fixtures/agent.replay.json", JSON.stringify({
      schema: "runx.replay.v1",
      fixture: "echo-agent-replay",
      prompt_fingerprint: sha256Stable(agentFixture),
      recorded_at: "1970-01-01T00:00:00.000Z",
      target: agentFixture.target,
      status: "success",
      outputs: {
        echo_packet: {
          schema: `${name}.echo.v1`,
          data: {
            message: "hello",
          },
        },
      },
      usage: {
        mode: "scaffold",
      },
    }, null, 2)),
    write(root, "fixtures/repos/readme-only/README.md", `# ${name}\n`),
    write(root, ".gitattributes", "tools/**/run.mjs linguist-generated=true\ntools/**/manifest.json linguist-generated=true\ntools/**/dist/** linguist-generated=true\n"),
    write(root, "tsconfig.json", JSON.stringify({
      extends: "@tsconfig/node20/tsconfig.json",
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
      },
      include: ["src/**/*.ts", "tools/**/*.ts"],
    }, null, 2)),
  ]);
}

function sanitizePackageName(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "runx-package";
}

async function write(root: string, relativePath: string, contents: string): Promise<void> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents.endsWith("\n") ? contents : `${contents}\n`);
}

function sha256Stable(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function sha256ToolSourceContents(files: Readonly<Record<string, string>>): string {
  const hash = createHash("sha256");
  for (const relativePath of ["src/index.ts", "run.mjs"]) {
    if (files[relativePath] === undefined) {
      continue;
    }
    hash.update(relativePath);
    hash.update("\0");
    hash.update(files[relativePath] ?? "");
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

async function main(): Promise<void> {
  const name = process.argv[2] ?? "runx-package";
  const directory = process.argv[3] ? path.resolve(process.argv[3]) : path.resolve(process.cwd(), name);
  await scaffoldRunxPackage({
    name,
    directory,
  });
  process.stdout.write(`Created ${directory}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  await main();
}
