import {
  analyzeRepo,
  buildRepoProfile,
  firstNonEmptyString,
  getRepoRoot,
  parseJsonInput,
  parseRepoSlug,
  parseRepositoryUrl,
  prune,
} from "../common.mjs";

const inputs = JSON.parse(process.env.RUNX_INPUTS_JSON || "{}");
const repoRoot = getRepoRoot(inputs);
const analysis = analyzeRepo(repoRoot);
const stackDetection = parseJsonInput(inputs.stack_detection, {}) || {};
const docsInputCandidates = Array.isArray(inputs.docs_input_candidates)
  ? inputs.docs_input_candidates
  : Array.isArray(parseJsonInput(inputs.docs_input_candidates, []))
    ? parseJsonInput(inputs.docs_input_candidates, [])
    : [];

const repoProfile = buildRepoProfile(analysis, {
  repo_url: inputs.repo_url,
  docs_url: inputs.docs_url,
});
const repoUrl = parseRepositoryUrl(analysis.package_json, inputs.repo_url);
const repoSlug = parseRepoSlug(repoUrl);
const docsUrl = firstNonEmptyString(inputs.docs_url);
const stack = firstNonEmptyString(stackDetection.stack, "unknown");
const markdownCount = analysis.markdown_files.length;
const structuredInputCount = docsInputCandidates.filter((candidate) =>
  ["config", "openapi", "doxygen", "mcp"].includes(String(candidate?.kind || ""))
).length;
const hasOnlyReadmeMarkdown = markdownCount === 1 && analysis.readme_files.length === 1 && structuredInputCount === 0;
const hasUsableInputs = docsInputCandidates.length > 0;
const painSignals = [];

if (stack === "sourcey") {
  painSignals.push("already_uses_sourcey");
}
if (!docsUrl) {
  painSignals.push("docs_url_missing");
}
if (!hasUsableInputs) {
  painSignals.push("no_supported_docs_inputs");
}
if (!docsInputCandidates.some((candidate) => candidate?.kind === "config") && hasUsableInputs) {
  painSignals.push("no_docs_config");
}
if (hasOnlyReadmeMarkdown) {
  painSignals.push("single_readme_surface");
}
if (analysis.openapi_files.length > 0 && !["sourcey", "redocly", "swagger_ui"].includes(stack)) {
  painSignals.push("api_spec_without_dedicated_docs_surface");
}
if ((analysis.doxygen_xml_files.length > 0 || analysis.doxyfiles.length > 0) && !["sourcey", "doxygen"].includes(stack)) {
  painSignals.push("doxygen_source_without_reader");
}

let qualityBand = "poor";
if (stack === "sourcey" && markdownCount >= 1) {
  qualityBand = structuredInputCount >= 2 || markdownCount >= 2 ? "excellent" : "good";
} else if (
  ["docusaurus", "mintlify", "gitbook", "redocly", "sphinx", "vitepress", "nextra", "starlight"].includes(stack)
  && (markdownCount >= 2 || structuredInputCount >= 1)
) {
  qualityBand = markdownCount >= 4 || structuredInputCount >= 2 ? "excellent" : "good";
} else if (hasUsableInputs && (structuredInputCount >= 1 || markdownCount >= 2)) {
  qualityBand = "mediocre";
} else if (markdownCount === 1) {
  qualityBand = "poor";
}

const previewRecommended = hasUsableInputs
  && stack !== "sourcey"
  && (qualityBand === "poor" || qualityBand === "mediocre" || stack === "unknown" || stack === "readme");

const summary = buildQualitySummary({
  stack,
  qualityBand,
  repoProfile,
  painSignals,
  markdownCount,
  structuredInputCount,
  previewRecommended,
});

process.stdout.write(JSON.stringify(prune({
  schema: "runx.docs_scan.v1",
  target: {
    repo_url: repoUrl,
    repo_slug: repoSlug,
    docs_url: docsUrl,
    default_branch: firstNonEmptyString(inputs.default_branch),
    language: repoProfile.language,
  },
  repo_profile: repoProfile,
  stack_detection: prune({
    stack,
    confidence: firstNonEmptyString(stackDetection.confidence, "low"),
    evidence: Array.isArray(stackDetection.evidence) ? stackDetection.evidence : [],
  }),
  docs_input_candidates: docsInputCandidates,
  quality_assessment: {
    quality_band: qualityBand,
    pain_signals: painSignals,
    summary,
  },
  preview_recommendation: {
    recommended: previewRecommended,
    rationale: buildPreviewRationale({ stack, hasUsableInputs, qualityBand, painSignals, previewRecommended }),
  },
  scan_context: prune({
    objective: firstNonEmptyString(inputs.objective),
    operator_context: firstNonEmptyString(inputs.scan_context),
  }),
})));

function buildPreviewRationale({ stack, hasUsableInputs, qualityBand, painSignals, previewRecommended }) {
  if (!hasUsableInputs) {
    return "No supported Markdown, OpenAPI, Doxygen, MCP, or Sourcey config inputs were detected in the bounded scan.";
  }
  if (stack === "sourcey") {
    return "The repo already exposes a Sourcey config, so this looks like an adopted target rather than a migration candidate.";
  }
  if (previewRecommended) {
    if (painSignals.includes("api_spec_without_dedicated_docs_surface")) {
      return "A Sourcey preview is worth generating because the repo has a real API spec but no strong dedicated docs surface was detected.";
    }
    if (painSignals.includes("single_readme_surface")) {
      return "A Sourcey preview is worth generating because the current surface appears to be a thin README-level docs experience.";
    }
    return `A Sourcey preview is worth generating because the bounded scan found usable inputs and the current docs quality band is '${qualityBand}'.`;
  }
  return `The bounded scan found usable inputs, but the current stack '${stack}' already looks strong enough that a Sourcey preview is not the next highest-leverage action.`;
}

function buildQualitySummary({
  stack,
  qualityBand,
  repoProfile,
  painSignals,
  markdownCount,
  structuredInputCount,
  previewRecommended,
}) {
  const subject = firstNonEmptyString(repoProfile.name, repoProfile.repo_slug, "This repo");
  const parts = [
    `${subject} scans as '${stack}' with a '${qualityBand}' docs surface.`,
    `${markdownCount} markdown page${markdownCount === 1 ? "" : "s"} and ${structuredInputCount} structured Sourcey-compatible input${structuredInputCount === 1 ? "" : "s"} were detected.`,
  ];
  if (painSignals.includes("already_uses_sourcey")) {
    parts.push("It already appears to be on Sourcey, so adoption work should focus elsewhere.");
  } else if (previewRecommended) {
    parts.push("The current surface leaves room for a private preview to demonstrate a stronger docs experience.");
  } else if (painSignals.length > 0) {
    parts.push(`The main observed gaps were ${painSignals.join(", ")}.`);
  }
  return parts.join(" ");
}
