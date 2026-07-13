import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.RUNX_INPUT_REPO_ROOT;
if (!root) throw new Error("repo_root is required");

const llmsPath = join(root, "sourcey-docs", "llms.txt");
const configPath = join(root, "sourcey.config.ts");
const llms = readFileSync(llmsPath, "utf8");
const config = readFileSync(configPath, "utf8");
const entries = [...llms.matchAll(/^- \[([^\]]+)\]\(([^)]+)\):/gm)].map(
  ([, title, target]) => ({ title, target }),
);

const expectedSources = [
  "README.md",
  "docs/getting-started.md",
  "docs/agent-skills.md",
  "docs/operator-skills.md",
  "docs/issue-to-pr.md",
  "docs/publishing.md",
  "docs/how-we-test.md",
  "docs/reference.md",
];

if (entries.length !== expectedSources.length) {
  throw new Error(`expected 8 llms entries, found ${entries.length}`);
}

for (const source of expectedSources) {
  if (!config.includes(`"${source}"`)) {
    throw new Error(`sourcey config is missing ${source}`);
  }
  if (!existsSync(join(root, source))) {
    throw new Error(`configured source does not exist: ${source}`);
  }
}

for (const entry of entries) {
  const marker = "/sourcey-docs/";
  const offset = entry.target.indexOf(marker);
  if (offset < 0) throw new Error(`unexpected target: ${entry.target}`);
  const generatedPath = join(root, "sourcey-docs", entry.target.slice(offset + marker.length));
  if (!existsSync(generatedPath)) {
    throw new Error(`generated page does not exist: ${entry.target}`);
  }
}

process.stdout.write(
  `${JSON.stringify({
    validation: {
      schema: "sourcey.artifact.validation.v1",
      status: "valid",
      entry_count: entries.length,
      source_count: expectedSources.length,
      generated_targets_checked: entries.map(({ target }) => target),
    },
  })}\n`,
);
