import { analyzeRepo, discoverInputCandidates, getRepoRoot } from "../common.mjs";

const inputs = JSON.parse(process.env.RUNX_INPUTS_JSON || "{}");
const repoRoot = getRepoRoot(inputs);
const analysis = analyzeRepo(repoRoot);
const candidates = discoverInputCandidates(analysis);

process.stdout.write(JSON.stringify({
  repo_root: repoRoot,
  candidates,
  counts: {
    markdown_pages: analysis.markdown_files.length,
    openapi_specs: analysis.openapi_files.length,
    doxygen_sources: analysis.doxygen_xml_files.length || analysis.doxyfiles.length,
    mcp_manifests: analysis.mcp_files.length,
  },
}));
