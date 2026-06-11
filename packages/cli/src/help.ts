import type { Writable } from "node:stream";

import { theme } from "./ui.js";

const BANNER_LINES = [
  "_______ __ __  ____ ___  ___",
  "\\_  __ \\  |  \\/    \\\\  \\/  /",
  " |  | \\/  |  /   |  \\>    < ",
  " |__|  |____/|___|  /__/\\_ \\",
  "                  \\/      \\/",
];

export function isHelpRequest(argv: readonly string[]): boolean {
  return argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h");
}

export function writeBanner(stream: Writable, env: NodeJS.ProcessEnv): void {
  const t = theme(stream, env);
  const gradient = t.on
    ? ["\u001b[38;5;201m", "\u001b[38;5;207m", "\u001b[38;5;177m", "\u001b[38;5;147m", "\u001b[38;5;117m"]
    : ["", "", "", "", ""];
  const lines: string[] = [""];
  for (let index = 0; index < BANNER_LINES.length; index += 1) {
    lines.push(`  ${gradient[index]}${t.bold}${BANNER_LINES[index]}${t.reset}`);
  }
  lines.push("");
  stream.write(`${lines.join("\n")}\n`);
}

export function writeUsage(stream: Writable, env: NodeJS.ProcessEnv = process.env): void {
  const t = theme(stream, env);
  const wantsBanner = t.on || env.RUNX_BANNER === "1";
  if (wantsBanner) {
    writeBanner(stream, env);
  }
  stream.write(
    [
      "Usage:",
      "  runx <command> [args]",
      "  runx --help",
      "  runx --version",
      "",
      "Commands:",
      "  runx new <name> [--directory dir] [--json]",
      "  runx init [-g|--global] [--prefetch official] [--json]",
      "  runx history [query] [--skill s] [--status s] [--source s] [--actor a] [--artifact-type t] [--since iso] [--until iso] [--receipt-dir dir] [--json]",
      "  runx list [tools|skills|graphs|packets|overlays] [--ok-only|--invalid-only] [--json]",
      "  runx config set|get|list [agent.provider|agent.model|agent.api_key] [value] [--json]",
      "  runx policy inspect|lint <policy.json> [--json]",
      "  runx publish <receipt.json> [--api-base-url url] [--token token] [--allow-local-api] [--json]",
      "  runx kernel eval --input <file|-> --json",
      "  runx doctor [path] [--json]",
      "  runx dev [root] [--lane lane] [--json]",
      "  runx mcp serve <skill-ref...> [--receipt-dir dir]",
      "  runx add <skill-ref> [--registry url|path] [--version version] [--to dir] [--digest sha256] [--json]",
      "  runx add <github-url> [--ref git-ref] [--api-base-url url] [--json]",
      "  runx skill <skill-ref|owner/name@version|skill-dir|SKILL.md> [--registry url|path] [--digest sha256] [--runner name] [--input key=value] [--flag value] [--receipt-dir dir] [--run-id id --answers file] [--json]",
      "  runx harness <fixture.yaml> [--json]",
      "  runx tool build <tool-dir>|--all [--json]",
      "  runx tool search <query> [--source source] [--json]",
      "  runx tool inspect <ref> [--source source] [--json]",
      "  runx registry search|read|resolve|install|publish ... --json",
      "",
    ].join("\n"),
  );
}
