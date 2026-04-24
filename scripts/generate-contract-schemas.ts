import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { runxGeneratedSchemaArtifacts } from "@runxhq/contracts";

const workspaceRoot = process.cwd();

await mkdir(path.join(workspaceRoot, "schemas"), { recursive: true });

for (const [fileName, schema] of Object.entries(runxGeneratedSchemaArtifacts)) {
  await writeFile(
    path.join(workspaceRoot, "schemas", fileName),
    `${JSON.stringify(schema, null, 2)}\n`,
  );
}
