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
    find: /^@runxhq\/adapters$/,
    replacement: workspacePath("packages/adapters/src/index.ts"),
  },
  {
    find: /^@runxhq\/adapters\/runtime$/,
    replacement: workspacePath("packages/adapters/src/runtime.ts"),
  },
  {
    find: /^@runxhq\/adapters\/(.+)$/,
    replacement: workspacePath("packages/adapters/src/$1/index.ts"),
  },
  {
    find: /^@runxhq\/authoring$/,
    replacement: workspacePath("packages/authoring/src/index.ts"),
  },
  {
    find: /^@runxhq\/cli$/,
    replacement: workspacePath("packages/cli/src/index.ts"),
  },
  {
    find: /^@runxhq\/cli\/metadata$/,
    replacement: workspacePath("packages/cli/src/metadata.ts"),
  },
  {
    find: /^@runxhq\/contracts$/,
    replacement: workspacePath("packages/contracts/src/index.ts"),
  },
  {
    find: /^@runxhq\/core$/,
    replacement: workspacePath("packages/core/src/index.ts"),
  },
  {
    find: /^@runxhq\/core\/(.+)$/,
    replacement: workspacePath("packages/core/src/$1/index.ts"),
  },
];
