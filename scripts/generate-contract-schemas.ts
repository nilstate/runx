import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { runxAuxiliarySchemas } from "../packages/contracts/src/index.js";

const workspaceRoot = process.cwd();
const schemaTargets = {
  "registry-binding.schema.json": runxAuxiliarySchemas.registryBinding,
  "review-receipt-output.schema.json": runxAuxiliarySchemas.reviewReceiptOutput,
} as const;

await mkdir(path.join(workspaceRoot, "schemas"), { recursive: true });

for (const [fileName, schema] of Object.entries(schemaTargets)) {
  await writeFile(
    path.join(workspaceRoot, "schemas", fileName),
    `${JSON.stringify(schema, null, 2)}\n`,
  );
}
