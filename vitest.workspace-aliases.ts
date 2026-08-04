import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.dirname(fileURLToPath(new URL("./package.json", import.meta.url)));
type WorkspaceAlias = {
  readonly find: string | RegExp;
  readonly replacement: string;
};

function workspacePath(relativePath: string): string {
  return path.join(workspaceRoot, relativePath);
}

export const workspaceAliases: readonly WorkspaceAlias[] = [
  {
    find: /^@runxhq\/extension-sdk$/,
    replacement: workspacePath("packages/extension-sdk/src/index.ts"),
  },
  {
    find: /^@runxhq\/contracts$/,
    replacement: workspacePath("packages/contracts/src/index.ts"),
  },
  {
    find: /^@runxhq\/host-adapters$/,
    replacement: workspacePath("packages/host-adapters/src/index.ts"),
  },
];
