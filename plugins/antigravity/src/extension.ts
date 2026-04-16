import { createIdeActionCore, type IdeActionCore } from "../../ide-core/src/index.js";
import { buildSkillPreview } from "../../ide-core/src/skill-authoring.js";

export interface CommandDisposable {
  readonly dispose?: () => void;
}

export interface RunxIdeHost {
  readonly registerCommand: (command: string, handler: (...args: readonly unknown[]) => unknown) => CommandDisposable;
}

export interface AntigravityExtensionContext {
  readonly subscriptions?: CommandDisposable[];
}

export function registerRunxCommands(host: RunxIdeHost, core: IdeActionCore = createIdeActionCore()): readonly CommandDisposable[] {
  return [
    host.registerCommand("runx.skill.run", async (skillPath, inputs) =>
      await core.runSkill({ skillPath: requiredString(skillPath, "skillPath"), inputs: optionalInputs(inputs) }),
    ),
    host.registerCommand("runx.receipt.inspect", async (receiptId) => await core.inspectReceipt(requiredString(receiptId, "receiptId"))),
    host.registerCommand("runx.history", async () => await core.history()),
    host.registerCommand("runx.skill.search", async (query) => await core.searchSkills({ query: requiredString(query, "query") })),
    host.registerCommand("runx.skill.add", async (ref) => await core.addSkill({ ref: requiredString(ref, "ref") })),
    host.registerCommand("runx.connect.list", async () => await core.connectList()),
    host.registerCommand("runx.harness.run", async (fixturePath) => await core.harnessRun(requiredString(fixturePath, "fixturePath"))),
    host.registerCommand("runx.skill.preview", (markdown, profileDocument) => buildSkillPreview({
      markdown: requiredString(markdown, "markdown"),
      profileDocument: typeof profileDocument === "string" ? profileDocument : undefined,
    })),
  ];
}

export async function activate(context: AntigravityExtensionContext): Promise<void> {
  const vscode = await loadVscodeApi();
  if (!vscode) {
    return;
  }
  context.subscriptions?.push(
    ...registerRunxCommands({
      registerCommand: (command, handler) => vscode.commands.registerCommand(command, handler),
    }),
  );
}

export function deactivate(): void {
  // VS Code-compatible extension hook.
}

interface VscodeApi {
  readonly commands: {
    readonly registerCommand: (command: string, handler: (...args: readonly unknown[]) => unknown) => CommandDisposable;
  };
}

async function loadVscodeApi(): Promise<VscodeApi | undefined> {
  try {
    const moduleName = "vscode";
    return (await import(moduleName)) as VscodeApi;
  } catch {
    return undefined;
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`runx command requires ${name}.`);
  }
  return value;
}

function optionalInputs(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;
}
