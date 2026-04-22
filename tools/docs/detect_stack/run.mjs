import { analyzeRepo, getRepoRoot, scoreStackDetection } from "../common.mjs";

const inputs = JSON.parse(process.env.RUNX_INPUTS_JSON || "{}");
const repoRoot = getRepoRoot(inputs);
const analysis = analyzeRepo(repoRoot);
const detection = scoreStackDetection(analysis);

process.stdout.write(JSON.stringify({
  repo_root: repoRoot,
  ...detection,
}));
