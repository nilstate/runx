import { spawnSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface ParserFixture {
  readonly name: string;
  readonly scope: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly expected: unknown;
}

const workspaceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureRoot = path.join(workspaceRoot, "fixtures", "parser");
const check = process.argv.includes("--check");
const selectedScope = process.argv.find((argument) => argument.startsWith("--scope="))?.slice(8);
const runx = process.env.RUNX_PARSER_EVAL_BIN
  ?? process.env.RUNX_DEV_RUST_CLI_BIN
  ?? path.join(workspaceRoot, "crates", "target", "debug", process.platform === "win32" ? "runx.exe" : "runx");

for (const scope of await parserScopes()) {
  if (selectedScope && scope !== selectedScope) continue;
  const directory = path.join(fixtureRoot, scope);
  const entries = (await readdir(directory)).filter((entry) => entry.endsWith(".json")).sort();
  for (const entry of entries) {
    const fixturePath = path.join(directory, entry);
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as ParserFixture;
    const expected = evaluate(scope, fixture.input);
    const updated = `${JSON.stringify({ ...fixture, expected })}\n`;
    if (check) {
      const current = await readFile(fixturePath, "utf8");
      if (current !== updated) throw new Error(`parser fixture is stale: ${path.relative(workspaceRoot, fixturePath)}`);
    } else {
      await writeFile(fixturePath, updated, "utf8");
    }
  }
}

console.log(`${check ? "checked" : "generated"} parser fixtures through the native parser`);

async function parserScopes(): Promise<readonly string[]> {
  const entries = await readdir(fixtureRoot, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function evaluate(scope: string, input: Readonly<Record<string, unknown>>): unknown {
  const request = { input: parserRequest(scope, input) };
  const result = spawnSync(runx, ["parser", "eval", "--input", "-", "--json"], {
    cwd: workspaceRoot,
    env: process.env,
    encoding: "utf8",
    input: JSON.stringify(request),
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const response = JSON.parse(result.stdout) as {
    readonly status?: string;
    readonly code?: string;
    readonly message?: string;
    readonly result?: { readonly value?: unknown };
  };
  if (result.status === 0 && response.status === "success" && response.result?.value !== undefined) {
    return { validated: response.result.value };
  }
  if (response.status === "error" && response.message) {
    const kind = response.code === "parse_error" ? "parse" : "validation";
    return { rejection: { kind, message: response.message } };
  }
  throw new Error(`native parser returned an unexpected response for ${scope}: ${result.stderr || result.stdout}`);
}

function parserRequest(
  scope: string,
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  switch (scope) {
    case "skills":
      return { kind: "parser.validateSkillMarkdown", ...input };
    case "runner-manifests":
      return { kind: "parser.validateRunnerManifestYaml", ...input };
    case "graphs":
      return { kind: "parser.validateGraphYaml", ...input };
    case "tool-manifests":
      return {
        kind: typeof input.json === "string"
          ? "parser.validateToolManifestJson"
          : "parser.validateToolManifestYaml",
        ...input,
      };
    case "installs":
      return { kind: "parser.validateSkillInstall", ...input };
    default:
      throw new Error(`unsupported parser fixture scope: ${scope}`);
  }
}
