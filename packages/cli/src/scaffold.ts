import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { hashStable, isNodeError } from "@runxhq/core/util";

import { readCliDependencyVersion, readCliPackageMetadata } from "./metadata.js";

const toolkitVersion = readCliDependencyVersion("@runxhq/authoring");
const authoringPackageVersion = `^${toolkitVersion}`;
const cliPackageVersion = `^${readCliPackageMetadata().version}`;

export interface ScaffoldRunxPackageOptions {
  readonly name: string;
  readonly directory: string;
}

export interface ScaffoldRunxPackageResult {
  readonly name: string;
  readonly packet_namespace: string;
  readonly directory: string;
  readonly files: readonly string[];
  readonly next_steps: readonly string[];
}

export async function scaffoldRunxPackage(options: ScaffoldRunxPackageOptions): Promise<ScaffoldRunxPackageResult> {
  const name = sanitizeRunxPackageName(options.name);
  const packetNamespace = packetNamespaceForName(name);
  const root = path.resolve(options.directory);
  await assertWritableScaffoldTarget(root);

  const packetId = `${packetNamespace}.echo.v1`;
  const toolSource = `import { defineTool, stringInput } from "@runxhq/authoring";

export default defineTool({
  name: "docs.echo",
  version: "0.1.0",
  description: "Echo a docs message.",
  inputs: {
    message: stringInput({ default: "hello" }),
  },
  output: {
    packet: "${packetId}",
    wrap_as: "echo_packet",
  },
  scopes: ["docs.read"],
  run({ inputs }) {
    return { message: inputs.message };
  },
});
`;
  const toolRuntime = `const fs = require("node:fs");
const rawInputs = process.env.RUNX_INPUTS_PATH
  ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
  : (process.env.RUNX_INPUTS_JSON || "{}");
const inputs = JSON.parse(rawInputs);
process.stdout.write(JSON.stringify({ schema: "${packetId}", data: { message: String(inputs.message || "hello") } }));
`;
  const toolInputs = {
    message: { type: "string", required: false, default: "hello" },
  };
  const toolOutput = { packet: packetId, wrap_as: "echo_packet" };
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
          matches_packet: packetId,
        },
      },
    },
  };

  const writes: ReadonlyArray<readonly [string, string]> = [
    ["package.json", JSON.stringify({
      name,
      version: "0.1.0",
      description: "Scaffolded runx skill package.",
      type: "module",
      publishConfig: {
        access: "public",
      },
      scripts: {
        build: "runx tool build --all --json",
        "runx:list": "runx list --json",
        "runx:doctor": "runx doctor --json",
        "runx:dev": "runx dev --lane deterministic --json",
        prepublishOnly: "runx tool build --all --json && runx doctor --json",
      },
      runx: {
        packets: ["./dist/packets/*.schema.json"],
      },
      devDependencies: {
        "@runxhq/authoring": authoringPackageVersion,
        "@runxhq/cli": cliPackageVersion,
        "@tsconfig/node20": "^20.1.6",
        "tsx": "^4.20.6",
      },
    }, null, 2)],
    ["README.md", `# ${name}

Runx authoring package: composable skills governed by typed contracts.

## Layout

- \`SKILL.md\`: Anthropic-standard skill description. Read by humans and agents.
- \`X.yaml\`: runx execution profile layered on top of \`SKILL.md\`.
- \`src/packets/\`: typed packet contracts authored with TypeBox.
- \`tools/\`: deterministic implementation units authored with \`defineTool\`.
- \`fixtures/\`: examples and tests across deterministic, agent, and repo-integration lanes.

## Authoring Loop

\`\`\`bash
pnpm install
pnpm build
pnpm runx:list
pnpm runx:doctor
pnpm runx:dev
\`\`\`

Edit \`tools/docs/echo/src/index.ts\`, then run \`runx tool build --all\` to regenerate \`manifest.json\` and \`run.mjs\`. Add fixtures in \`tools/<namespace>/<name>/fixtures/\` to lock behaviour.

Packet IDs are immutable. Schema changes mean a new packet ID, not an in-place edit.

## Bootstrap

- Canonical: \`runx new ${name}\`
- Cold start: \`npm create @runxhq/skill@latest ${name}\`

## Publish

The scaffold includes \`.github/workflows/publish.yml\`, which publishes with npm provenance from GitHub Actions. Before publishing, update \`package.json\` metadata for your repo and package.
`],
    ["SKILL.md", `---
name: ${name}
description: Scaffolded runx skill package.
---

Use this skill to demonstrate a governed runx authoring package.
`],
    ["X.yaml", `skill: ${name}

runners:
  default:
    default: true
    type: graph
    inputs:
      message:
        type: string
        required: false
        default: hello
    graph:
      name: ${name}
      steps:
        - id: echo
          tool: docs.echo
          inputs:
            message: inputs.message
`],
    ["src/packets/echo.ts", `import { definePacket, t } from "@runxhq/authoring";

export const EchoPacket = definePacket({
  id: "${packetId}",
  schema: t.Object({
    message: t.String(),
  }),
});
`],
    ["dist/packets/echo.v1.schema.json", JSON.stringify({
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": `https://schemas.runx.dev/${packetNamespace.replaceAll(".", "/")}/echo/v1.json`,
      "x-runx-packet-id": packetId,
      type: "object",
      required: ["message"],
      properties: {
        message: { type: "string" },
      },
      additionalProperties: false,
    }, null, 2)],
    ["tools/docs/echo/src/index.ts", toolSource],
    ["tools/docs/echo/run.mjs", toolRuntime],
    ["tools/docs/echo/manifest.json", JSON.stringify({
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
      toolkit_version: toolkitVersion,
    }, null, 2)],
    ["tools/docs/echo/fixtures/basic.yaml", `name: echo-basic
lane: deterministic
target:
  kind: tool
  ref: docs.echo
inputs:
  message: hello
expect:
  status: success
  output:
    subset:
      schema: ${packetId}
      data:
        message: hello
`],
    ["fixtures/agent.yaml", `name: echo-agent-replay
lane: agent
target:
  kind: skill
  ref: .
inputs:
  message: hello
agent:
  mode: replay
expect:
  status: success
  outputs:
    echo_packet:
      matches_packet: ${packetId}
`],
    ["fixtures/agent.replay.json", JSON.stringify({
      schema: "runx.replay.v1",
      fixture: "echo-agent-replay",
      prompt_fingerprint: sha256Stable(agentFixture),
      recorded_at: "1970-01-01T00:00:00.000Z",
      target: agentFixture.target,
      status: "success",
      outputs: {
        echo_packet: {
          schema: packetId,
          data: {
            message: "hello",
          },
        },
      },
      usage: {
        mode: "scaffold",
      },
    }, null, 2)],
    ["fixtures/repos/readme-only/README.md", `# ${name}
`],
    [".github/workflows/publish.yml", `name: publish

on:
  workflow_dispatch:
  release:
    types:
      - published

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: https://registry.npmjs.org
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm runx:doctor
      - run: npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
`],
    [".gitignore", `node_modules/
.runx/
*.tgz
`],
    [".gitattributes", "tools/**/run.mjs linguist-generated=true\ntools/**/manifest.json linguist-generated=true\ntools/**/dist/** linguist-generated=true\n"],
    ["tsconfig.json", JSON.stringify({
      extends: "@tsconfig/node20/tsconfig.json",
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
      },
      include: ["src/**/*.ts", "tools/**/*.ts"],
    }, null, 2)],
  ];

  await mkdir(root, { recursive: true });
  await Promise.all(writes.map(([relativePath, contents]) => write(root, relativePath, contents)));

  return {
    name,
    packet_namespace: packetNamespace,
    directory: root,
    files: writes.map(([relativePath]) => relativePath),
    next_steps: [
      `cd ${root}`,
      "pnpm install",
      "pnpm build",
      "runx dev",
    ],
  };
}

export function sanitizeRunxPackageName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[._-]+|[._-]+$/g, "") || "runx-package";
}

function packetNamespaceForName(value: string): string {
  return value
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    || "runx.package";
}

async function assertWritableScaffoldTarget(root: string): Promise<void> {
  const entries = await readdir(root).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (entries && entries.length > 0) {
    throw new Error(`Refusing to scaffold into non-empty directory: ${root}`);
  }
}

async function write(root: string, relativePath: string, contents: string): Promise<void> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents.endsWith("\n") ? contents : `${contents}\n`);
}

function sha256Stable(value: unknown): string {
  return `sha256:${hashStable(value)}`;
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

