import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vscode",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".sourcey",
  ".runx",
  ".turbo",
  ".vercel",
]);

const PACKAGE_KEYS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const SOURCEY_CONFIG_RE = /(^|\/)sourcey\.config\.(?:[cm]?js|ts)$/i;
const DOCUSAURUS_CONFIG_RE = /(^|\/)docusaurus\.config\.(?:[cm]?js|ts)$/i;
const VITEPRESS_CONFIG_RE = /(^|\/)\.vitepress\/config\.(?:[cm]?js|ts)$/i;
const NEXTRA_CONFIG_RE = /(^|\/)(theme|theme\.docs)\.config\.(?:[cm]?jsx?|tsx?)$/i;
const STARLIGHT_CONFIG_RE = /(^|\/)starlight\.config\.(?:[cm]?js|ts)$/i;
const MINTLIFY_CONFIG_RE = /(^|\/)(mint|docs)\.json$/i;
const GITBOOK_CONFIG_RE = /(^|\/)(book\.json|\.gitbook\.ya?ml)$/i;
const REDOCLY_CONFIG_RE = /(^|\/)\.?redocly\.ya?ml$/i;
const DOXYGEN_XML_RE = /(^|\/)xml\/index\.xml$/i;
const DOXYFILE_RE = /(^|\/)doxyfile(?:\.[^/]+)?$/i;
const SPHINX_CONFIG_RE = /(^|\/)(docs|doc)(\/source)?\/conf\.py$/i;
const OPENAPI_RE = /(^|\/)(openapi|swagger)(?:[-_.][^/]+)?\.(?:ya?ml|json)$/i;
const MARKDOWN_RE = /\.(?:md|mdx)$/i;
const MCP_RE = /(^|\/)(mcp(?:-manifest)?\.json|\.well-known\/mcp\.json)$/i;
const README_RE = /(^|\/)readme\.mdx?$/i;

export function getRepoRoot(inputs) {
  const workspaceCwd = firstNonEmptyString(process.env.RUNX_CWD, process.env.INIT_CWD, process.cwd());
  const requestedRoot = firstNonEmptyString(inputs.repo_root, inputs.project, inputs.fixture);
  if (!requestedRoot) {
    return path.resolve(String(workspaceCwd));
  }
  return path.isAbsolute(requestedRoot)
    ? requestedRoot
    : path.resolve(String(workspaceCwd), requestedRoot);
}

export function parseJsonInput(value, fallback = undefined) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    return fallback;
  }
  return fallback;
}

export function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

export function prune(value) {
  if (Array.isArray(value)) {
    const items = value.map((entry) => prune(entry)).filter((entry) => entry !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (!value || typeof value !== "object") {
    return value === undefined ? undefined : value;
  }
  const entries = Object.entries(value)
    .map(([key, nested]) => [key, prune(nested)])
    .filter(([, nested]) => nested !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function collectRepoFiles(repoRoot, { maxFiles = 1500, maxDepth = 8 } = {}) {
  const files = [];

  function walk(currentDir, depth) {
    if (files.length >= maxFiles || depth > maxDepth || !existsSync(currentDir)) {
      return;
    }

    const entries = readdirSync(currentDir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        return;
      }
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.relative(repoRoot, absolutePath).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        walk(absolutePath, depth + 1);
        continue;
      }

      if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }

  walk(repoRoot, 0);
  return files;
}

export function readPackageMetadata(repoRoot) {
  const packagePath = path.join(repoRoot, "package.json");
  if (!existsSync(packagePath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(packagePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function collectPackageNames(packageJson) {
  const names = new Set();
  for (const key of PACKAGE_KEYS) {
    const section = packageJson?.[key];
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      continue;
    }
    for (const name of Object.keys(section)) {
      names.add(name);
    }
  }
  return names;
}

export function parseRepositoryUrl(packageJson, explicitRepoUrl) {
  if (firstNonEmptyString(explicitRepoUrl)) {
    return firstNonEmptyString(explicitRepoUrl);
  }
  const repository = packageJson?.repository;
  if (typeof repository === "string") {
    return normalizeRepositoryUrl(repository);
  }
  if (repository && typeof repository === "object" && !Array.isArray(repository)) {
    return normalizeRepositoryUrl(repository.url);
  }
  return undefined;
}

export function normalizeRepositoryUrl(value) {
  const text = firstNonEmptyString(value);
  if (!text) {
    return undefined;
  }
  if (text.startsWith("git+https://")) {
    return text.slice(4).replace(/\.git$/i, "");
  }
  if (text.startsWith("https://")) {
    return text.replace(/\.git$/i, "");
  }
  const sshMatch = text.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}`;
  }
  return text.replace(/\.git$/i, "");
}

export function parseRepoSlug(value) {
  const text = firstNonEmptyString(value);
  if (!text) {
    return undefined;
  }
  const httpsMatch = text.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\/)?$/i);
  if (httpsMatch) {
    return httpsMatch[1];
  }
  const sshMatch = text.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return sshMatch[1];
  }
  return undefined;
}

export function detectPrimaryLanguage(files) {
  const counts = new Map();
  const extensionMap = new Map([
    [".ts", "TypeScript"],
    [".tsx", "TypeScript"],
    [".js", "JavaScript"],
    [".jsx", "JavaScript"],
    [".py", "Python"],
    [".go", "Go"],
    [".rs", "Rust"],
    [".java", "Java"],
    [".kt", "Kotlin"],
    [".c", "C"],
    [".cc", "C++"],
    [".cpp", "C++"],
    [".cxx", "C++"],
    [".hpp", "C++"],
    [".h", "C/C++"],
    [".cs", "C#"],
    [".rb", "Ruby"],
    [".php", "PHP"],
    [".swift", "Swift"],
  ]);

  for (const file of files) {
    const extension = path.extname(file).toLowerCase();
    const language = extensionMap.get(extension);
    if (!language) {
      continue;
    }
    counts.set(language, (counts.get(language) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .at(0)?.[0];
}

export function analyzeRepo(repoRoot) {
  const files = collectRepoFiles(repoRoot);
  const packageJson = readPackageMetadata(repoRoot);
  const packageNames = collectPackageNames(packageJson);

  const sourceyConfigs = files.filter((file) => SOURCEY_CONFIG_RE.test(file));
  const docusaurusConfigs = files.filter((file) => DOCUSAURUS_CONFIG_RE.test(file));
  const vitepressConfigs = files.filter((file) => VITEPRESS_CONFIG_RE.test(file));
  const nextraConfigs = files.filter((file) => NEXTRA_CONFIG_RE.test(file));
  const starlightConfigs = files.filter((file) => STARLIGHT_CONFIG_RE.test(file));
  const mintlifyConfigs = files.filter((file) => MINTLIFY_CONFIG_RE.test(file));
  const gitbookConfigs = files.filter((file) => GITBOOK_CONFIG_RE.test(file));
  const redoclyConfigs = files.filter((file) => REDOCLY_CONFIG_RE.test(file));
  const doxygenXmlFiles = files.filter((file) => DOXYGEN_XML_RE.test(file));
  const doxyfiles = files.filter((file) => DOXYFILE_RE.test(file));
  const sphinxConfigs = files.filter((file) => SPHINX_CONFIG_RE.test(file));
  const openapiFiles = files.filter((file) => OPENAPI_RE.test(file));
  const markdownFiles = files.filter((file) => MARKDOWN_RE.test(file));
  const mcpFiles = files.filter((file) => MCP_RE.test(file));
  const readmeFiles = files.filter((file) => README_RE.test(file));

  return {
    repo_root: repoRoot,
    files,
    package_json: packageJson,
    package_names: packageNames,
    sourcey_configs: sourceyConfigs,
    docusaurus_configs: docusaurusConfigs,
    vitepress_configs: vitepressConfigs,
    nextra_configs: nextraConfigs,
    starlight_configs: starlightConfigs,
    mintlify_configs: mintlifyConfigs,
    gitbook_configs: gitbookConfigs,
    redocly_configs: redoclyConfigs,
    doxygen_xml_files: doxygenXmlFiles,
    doxyfiles,
    sphinx_configs: sphinxConfigs,
    openapi_files: openapiFiles,
    markdown_files: markdownFiles,
    mcp_files: mcpFiles,
    readme_files: readmeFiles,
  };
}

export function buildRepoProfile(analysis, explicit = {}) {
  const repoUrl = parseRepositoryUrl(analysis.package_json, explicit.repo_url);
  const repoSlug = parseRepoSlug(repoUrl);
  const docsUrl = firstNonEmptyString(explicit.docs_url);
  const name = firstNonEmptyString(
    analysis.package_json?.name,
    repoSlug?.split("/").at(1),
    path.basename(analysis.repo_root),
  );

  return prune({
    name,
    homepage_url: firstNonEmptyString(analysis.package_json?.homepage),
    repository_url: repoUrl,
    repo_slug: repoSlug,
    docs_url: docsUrl,
    language: detectPrimaryLanguage(analysis.files),
    markdown_pages: analysis.markdown_files.length,
    supported_inputs: prune({
      config: analysis.sourcey_configs.length,
      openapi: analysis.openapi_files.length,
      doxygen: analysis.doxygen_xml_files.length || analysis.doxyfiles.length,
      mcp: analysis.mcp_files.length,
    }),
  });
}

export function confidenceFromScore(score) {
  if (score >= 80) {
    return "high";
  }
  if (score >= 45) {
    return "medium";
  }
  return "low";
}

export function scoreStackDetection(analysis) {
  const candidates = [];
  const packageNames = analysis.package_names;

  function add(stack, score, evidence) {
    candidates.push({ stack, score, evidence });
  }

  if (analysis.sourcey_configs.length > 0) {
    add("sourcey", 98, [
      `Found Sourcey config: ${analysis.sourcey_configs[0]}`,
      analysis.openapi_files.length > 0 ? `Found OpenAPI input: ${analysis.openapi_files[0]}` : undefined,
      analysis.mcp_files.length > 0 ? `Found MCP manifest: ${analysis.mcp_files[0]}` : undefined,
    ].filter(Boolean));
  } else if (packageNames.has("sourcey")) {
    add("sourcey", 72, ["package.json depends on sourcey"]);
  }

  if (analysis.docusaurus_configs.length > 0 || packageNames.has("@docusaurus/core")) {
    add("docusaurus", analysis.docusaurus_configs.length > 0 ? 92 : 68, [
      analysis.docusaurus_configs.length > 0 ? `Found Docusaurus config: ${analysis.docusaurus_configs[0]}` : undefined,
      packageNames.has("@docusaurus/core") ? "package.json depends on @docusaurus/core" : undefined,
    ].filter(Boolean));
  }

  if (analysis.mintlify_configs.length > 0) {
    add("mintlify", 90, [`Found Mintlify config: ${analysis.mintlify_configs[0]}`]);
  }

  if (analysis.gitbook_configs.length > 0) {
    add("gitbook", 88, [`Found GitBook config: ${analysis.gitbook_configs[0]}`]);
  }

  if (analysis.redocly_configs.length > 0 || packageNames.has("@redocly/cli")) {
    add("redocly", analysis.redocly_configs.length > 0 ? 86 : 62, [
      analysis.redocly_configs.length > 0 ? `Found Redocly config: ${analysis.redocly_configs[0]}` : undefined,
      packageNames.has("@redocly/cli") ? "package.json depends on @redocly/cli" : undefined,
    ].filter(Boolean));
  }

  if (analysis.vitepress_configs.length > 0 || packageNames.has("vitepress")) {
    add("vitepress", analysis.vitepress_configs.length > 0 ? 90 : 64, [
      analysis.vitepress_configs.length > 0 ? `Found VitePress config: ${analysis.vitepress_configs[0]}` : undefined,
      packageNames.has("vitepress") ? "package.json depends on vitepress" : undefined,
    ].filter(Boolean));
  }

  if (analysis.nextra_configs.length > 0 || packageNames.has("nextra")) {
    add("nextra", analysis.nextra_configs.length > 0 ? 84 : 62, [
      analysis.nextra_configs.length > 0 ? `Found Nextra config: ${analysis.nextra_configs[0]}` : undefined,
      packageNames.has("nextra") ? "package.json depends on nextra" : undefined,
    ].filter(Boolean));
  }

  if (
    analysis.starlight_configs.length > 0
    || packageNames.has("@astrojs/starlight")
    || packageNames.has("starlight")
  ) {
    add("starlight", analysis.starlight_configs.length > 0 ? 84 : 60, [
      analysis.starlight_configs.length > 0 ? `Found Starlight config: ${analysis.starlight_configs[0]}` : undefined,
      packageNames.has("@astrojs/starlight") || packageNames.has("starlight")
        ? "package.json depends on a Starlight package"
        : undefined,
    ].filter(Boolean));
  }

  if (analysis.sphinx_configs.length > 0) {
    add("sphinx", 82, [`Found Sphinx config: ${analysis.sphinx_configs[0]}`]);
  }

  if (analysis.doxygen_xml_files.length > 0 || analysis.doxyfiles.length > 0) {
    add("doxygen", analysis.doxygen_xml_files.length > 0 ? 80 : 58, [
      analysis.doxygen_xml_files.length > 0 ? `Found Doxygen XML index: ${analysis.doxygen_xml_files[0]}` : undefined,
      analysis.doxyfiles.length > 0 ? `Found Doxyfile: ${analysis.doxyfiles[0]}` : undefined,
    ].filter(Boolean));
  }

  if (analysis.openapi_files.length > 0 && (packageNames.has("swagger-ui-dist") || packageNames.has("swagger-ui-react"))) {
    add("swagger_ui", 66, [
      `Found OpenAPI spec: ${analysis.openapi_files[0]}`,
      packageNames.has("swagger-ui-dist") ? "package.json depends on swagger-ui-dist" : undefined,
      packageNames.has("swagger-ui-react") ? "package.json depends on swagger-ui-react" : undefined,
    ].filter(Boolean));
  }

  if (analysis.readme_files.length > 0 || analysis.markdown_files.length > 0) {
    add("readme", analysis.markdown_files.length >= 3 ? 42 : 24, [
      analysis.readme_files.length > 0 ? `Found README surface: ${analysis.readme_files[0]}` : undefined,
      analysis.markdown_files.length > 1 ? `Found ${analysis.markdown_files.length} markdown pages` : undefined,
    ].filter(Boolean));
  }

  const selected = [...candidates]
    .sort((left, right) => right.score - left.score || left.stack.localeCompare(right.stack))
    .at(0);

  if (!selected) {
    return {
      stack: "unknown",
      confidence: "low",
      evidence: ["No supported docs stack signature was detected from the bounded repo scan."],
    };
  }

  return {
    stack: selected.stack,
    confidence: confidenceFromScore(selected.score),
    evidence: selected.evidence,
  };
}

export function discoverInputCandidates(analysis) {
  const candidates = [];

  function add(kind, pathValue, confidence, evidence) {
    const pathText = firstNonEmptyString(pathValue);
    const key = `${kind}:${pathText || ""}`;
    if (candidates.some((entry) => `${entry.kind}:${entry.path || ""}` === key)) {
      return;
    }
    candidates.push(prune({
      kind,
      path: pathText,
      confidence,
      evidence,
    }));
  }

  if (analysis.sourcey_configs.length > 0) {
    add("config", analysis.sourcey_configs[0], "high", [
      `Found Sourcey config: ${analysis.sourcey_configs[0]}`,
    ]);
  }

  if (analysis.openapi_files.length > 0) {
    add("openapi", preferredOpenApiPath(analysis.openapi_files), analysis.openapi_files.length > 1 ? "high" : "medium", [
      `Found ${analysis.openapi_files.length} OpenAPI candidate${analysis.openapi_files.length === 1 ? "" : "s"}`,
      `Preferred spec: ${preferredOpenApiPath(analysis.openapi_files)}`,
    ]);
  }

  const markdownRoot = preferredMarkdownPath(analysis.markdown_files);
  if (markdownRoot) {
    add("markdown", markdownRoot, analysis.markdown_files.length >= 3 ? "high" : "medium", [
      `Found ${analysis.markdown_files.length} markdown page${analysis.markdown_files.length === 1 ? "" : "s"}`,
      analysis.readme_files.length > 0 ? `README surface: ${analysis.readme_files[0]}` : undefined,
    ].filter(Boolean));
  }

  const doxygenXmlDir = analysis.doxygen_xml_files.at(0)
    ? path.posix.dirname(analysis.doxygen_xml_files[0])
    : undefined;
  if (doxygenXmlDir || analysis.doxyfiles.length > 0) {
    add("doxygen", doxygenXmlDir || analysis.doxyfiles[0], doxygenXmlDir ? "high" : "medium", [
      doxygenXmlDir ? `Found Doxygen XML directory: ${doxygenXmlDir}` : undefined,
      analysis.doxyfiles.length > 0 ? `Found Doxyfile: ${analysis.doxyfiles[0]}` : undefined,
    ].filter(Boolean));
  }

  if (analysis.mcp_files.length > 0) {
    add("mcp", analysis.mcp_files[0], analysis.mcp_files.length > 1 ? "high" : "medium", [
      `Found MCP manifest: ${analysis.mcp_files[0]}`,
    ]);
  }

  return candidates.sort((left, right) =>
    candidateSortKey(left).localeCompare(candidateSortKey(right)),
  );
}

function preferredOpenApiPath(paths) {
  return [...paths].sort((left, right) => {
    const leftScore = /(^|\/)openapi\.ya?ml$/i.test(left) ? 0 : 1;
    const rightScore = /(^|\/)openapi\.ya?ml$/i.test(right) ? 0 : 1;
    return leftScore - rightScore || left.localeCompare(right);
  })[0];
}

function preferredMarkdownPath(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return undefined;
  }
  const docsPath = paths.find((file) => /(^|\/)docs\//i.test(file));
  if (docsPath) {
    const [root] = docsPath.split("/");
    return root || docsPath;
  }
  const readme = paths.find((file) => README_RE.test(file));
  return readme || paths[0];
}

function candidateSortKey(candidate) {
  const rank = { high: "0", medium: "1", low: "2" }[candidate.confidence] || "9";
  return `${rank}:${candidate.kind}:${candidate.path || ""}`;
}
