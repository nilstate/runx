import {
  artifact,
  defineTool,
  firstNonEmptyString,
  optionalArtifact,
} from "../../_lib/harness.mjs";

const tool = defineTool({
  schema: "runx.sourcey.packet.v1",
  inputs: {
    discovery_report: artifact(),
    doc_bundle: artifact(),
    project_brief: optionalArtifact(),
    sourcey_build_report: artifact(),
    evaluation_report: artifact(),
    revision_bundle: artifact(),
    sourcey_verification_report: artifact(),
  },
  run({ inputs }) {
    const {
      discovery_report: discoveryReport,
      doc_bundle: docBundle,
      project_brief: projectBrief,
      sourcey_build_report: buildReport,
      evaluation_report: evaluationReport,
      revision_bundle: revisionBundle,
      sourcey_verification_report: verificationReport,
    } = inputs;

    return {
      verified: verificationReport.verified === true,
      output_dir: firstNonEmptyString(verificationReport.output_dir, buildReport.output_dir),
      contains_doctype: verificationReport.contains_doctype === true,
      discovery_report: discoveryReport,
      project_brief: projectBrief,
      doc_bundle: docBundle,
      build_report: buildReport,
      evaluation_report: evaluationReport,
      revision_bundle: revisionBundle,
      verification_report: verificationReport,
    };
  },
});

await tool.main();
