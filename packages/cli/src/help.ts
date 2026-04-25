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
      "  runx <skill> [--runner runner-name] [--input value] [--non-interactive] [--json] [--answers answers.json]",
      "  runx ./skill-dir|./SKILL.md [--runner runner-name] [--input value] [--non-interactive] [--json] [--answers answers.json]",
      "  runx surface run <skill> [--runner runner-name] [--receipt-dir dir] [--input-json file|-]",
      "  runx surface inspect <run-id|receipt-id> [--receipt-dir dir]",
      "  runx surface resume <run-id> [--receipt-dir dir] [--input-json file|-]",
      "  runx evolve [objective] [--receipt run-id] [--non-interactive] [--json] [--answers answers.json]",
      "  runx resume <run-id> [--non-interactive] [--json] [--answers answers.json]",
      "  runx replay <run-id|receipt-id> [--receipt-dir dir] [--non-interactive] [--json] [--answers answers.json]",
      "  runx diff <left-run-or-receipt> <right-run-or-receipt> [--receipt-dir dir] [--json]",
      "  runx search <query> [--source registry|marketplace|fixture-marketplace] [--json]",
      "  runx add <ref> [--version version] [--to skills-dir] [--registry url] [--digest sha256] [--json]",
      "  runx inspect <receipt-id> [--receipt-dir dir] [--json]",
      "  runx history [query] [--skill s] [--status s] [--source s] [--actor a] [--artifact-type t] [--since iso] [--until iso] [--receipt-dir dir] [--json]",
      "  runx export-receipts --trainable [--receipt-dir dir] [--since iso] [--until iso] [--status pending|complete|expired] [--source source-type]",
      "  runx knowledge show --project . [--json]",
      "  runx connect list|revoke <grant-id>|<provider> [--scope scope] [--scope-family family] [--authority-kind read_only|constructive|destructive] [--target-repo owner/repo] [--target-locator locator] [--json]",
      "  runx config set|get|list [agent.provider|agent.model|agent.api_key] [value] [--json]",
      "  runx new <name> [--directory dir] [--json]",
      "  runx init [-g|--global] [--prefetch official] [--json]",
      "  runx harness <fixture.yaml|skill-dir|SKILL.md> [--json]",
      "  runx list [tools|skills|chains|packets|overlays] [--ok-only|--invalid-only] [--json]",
      "  runx doctor [path] [--fix] [--explain id|--list-diagnostics] [--json]",
      "  runx dev [path] [--lane deterministic|agent|repo-integration|all] [--record] [--json]",
      "  runx mcp serve <skill-ref> [<skill-ref> ...]",
      "  runx tool search <query> [--source fixture-mcp] [--json]",
      "  runx tool inspect <ref> [--source fixture-mcp] [--json]",
      "  runx tool build|migrate <tool-dir>|--all [--json]",
      "",
      "Core Flow:",
      "  runx search docs",
      "  runx <skill> --project .",
      "  runx evolve",
      "  runx surface run sourcey",
      "  runx surface inspect <run-id>",
      "  runx surface resume <run-id>",
      "  runx new docs-demo",
      "  runx init",
      "  runx init -g --prefetch official",
      "  runx resume <run-id>",
      "  runx replay <run-id>",
      "  runx diff <left> <right>",
      "  runx inspect <receipt-id>",
      "  runx list",
      "  runx doctor",
      "  runx ./skills/local-operator --runner health-check",
      "  runx ./skills/local-operator --runner reconcile --issue owner/repo#issue/2",
      "  runx dev",
      "  runx tool search echo --source fixture-mcp",
      "  runx tool inspect fixture.echo --source fixture-mcp",
      "  runx mcp serve fixtures/skills/echo",
      "",
      "Cold Start:",
      "  npm create @runxhq/skill@latest docs-demo",
      "",
      "Manage Skills:",
      "  runx skill search <query>",
      "  runx skill add <ref>",
      "  runx skill publish <skill-dir|SKILL.md> [--owner owner] [--version version] [--registry url-or-path] [--json]",
      "  runx skill inspect <receipt-id> [--receipt-dir dir] [--json]",
      "  runx skill <skill-dir|SKILL.md>",
      "",
    ].join("\n"),
  );
}
