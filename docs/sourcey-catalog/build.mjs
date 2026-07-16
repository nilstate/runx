import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SOURCEY_VERSION = "3.6.5";
const CONFIG_FILE = "sourcey.config.ts";

export function renderSourceyConfig(catalog) {
  if (!catalog || !Array.isArray(catalog.groups)) throw new TypeError("catalog groups must be an array");

  const groups = [
    { name: "Introduction", slugs: ["introduction"] },
    ...catalog.groups.map((group) => {
      if (typeof group?.name !== "string" || !Array.isArray(group.entries)) {
        throw new TypeError("catalog groups must have a name and entries array");
      }
      return { name: group.name, slugs: group.entries.map(({ slug }) => slug) };
    })
  ];
  const seen = new Set();
  for (const { slugs } of groups.slice(1)) {
    for (const slug of slugs) {
      if (typeof slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
        throw new Error("catalog slugs must be lowercase kebab-case");
      }
      if (seen.has(slug)) throw new Error(`duplicate slug: ${slug}`);
      seen.add(slug);
    }
  }

  const renderedGroups = groups.map(({ name, slugs }) => [
    "            {",
    `              group: ${JSON.stringify(name)},`,
    `              pages: [${slugs.map((slug) => JSON.stringify(`pages/${slug}`)).join(", ")}],`,
    "            },"
  ].join("\n")).join("\n");

  return `export default {
  name: "Runx Governed Skill Catalog",
  siteUrl: "https://github.com",
  baseUrl: "/runxhq/runx",
  repo: "https://github.com/runxhq/runx",
  editBranch: "main",
  editBasePath: "docs/sourcey-catalog",
  theme: {
    preset: "default",
    colors: { primary: "#0f766e", light: "#14b8a6", dark: "#134e4a" },
  },
  navigation: {
    tabs: [
      {
        tab: "Skills",
        slug: "",
        groups: [
${renderedGroups}
        ],
      },
    ],
  },
};
`;
}

export function buildCommand(catalogDir, options = {}) {
  const root = path.resolve(catalogDir);
  const outputDir = path.resolve(options.outputDir ?? path.join(root, "site"));
  const expectedOutput = path.join(root, "site");
  if (outputDir !== expectedOutput) {
    throw new Error("outputDir must be the site directory inside the catalog directory");
  }

  const args = ["build", "-o", "site", "--quiet"];
  const command = options.sourceyBin
    ? [path.resolve(options.sourceyBin), ...args]
    : ["npx", "-y", `sourcey@${SOURCEY_VERSION}`, ...args];
  return { command, outputDir };
}

export async function buildCatalog({ catalogDir, outputDir, sourceyBin } = {}) {
  const root = path.resolve(catalogDir ?? path.dirname(fileURLToPath(import.meta.url)));
  const plan = buildCommand(root, { outputDir, sourceyBin });
  const catalog = JSON.parse(await readFile(path.join(root, "catalog.json"), "utf8"));
  const config = renderSourceyConfig(catalog);

  await writeFile(path.join(root, CONFIG_FILE), config, "utf8");
  await rm(plan.outputDir, { recursive: true, force: true });
  await run(plan.command, root);
  await verifyBuildArtifacts(plan.outputDir, catalog);

  return {
    page_count: catalog.groups.flatMap((group) => group.entries).length,
    output_dir: plan.outputDir,
    command: plan.command
  };
}

async function verifyBuildArtifacts(outputDir, catalog) {
  const required = [
    "index.html",
    "search-index.json",
    "sourcey.css",
    "sourcey.js",
    "llms.txt",
    "llms-full.txt",
    "pages/introduction.html",
    ...catalog.groups.flatMap((group) => group.entries.map(({ slug }) => `pages/${slug}.html`)),
  ];

  for (const relativePath of required) {
    const artifact = path.join(outputDir, relativePath);
    try {
      const metadata = await lstat(artifact);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) throw new Error();
    } catch {
      throw new Error(`missing or empty Sourcey build artifact: ${relativePath}`);
    }
  }
}

async function run(command, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Sourcey build failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildCatalog().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
