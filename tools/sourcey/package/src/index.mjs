import {
  defineTool,
  firstNonEmptyString,
} from "@runxhq/extension-sdk";

export default defineTool({
  name: "sourcey.package",
  run({ inputs }) {
    const {
      discovery_report: discoveryReport,
      doc_bundle: docBundle,
      project_brief: projectBrief,
      sourcey_build_report: buildReport,
      evaluation_report: evaluationReport,
      revision_bundle: revisionBundle,
      sourcey_verification_proof: verificationReport,
    } = inputs;

    return {
      verified: record(verificationReport).verified === true,
      output_dir: firstNonEmptyString(record(verificationReport).output_dir, record(buildReport).output_dir),
      contains_doctype: record(verificationReport).contains_doctype === true,
      discovery_report: discoveryReport,
      project_brief: projectBrief,
      doc_bundle: docBundle,
      build_report: buildReport,
      evaluation_report: evaluationReport,
      revision_bundle: revisionBundle,
      verification_proof: verificationReport,
    };
  },
});

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
