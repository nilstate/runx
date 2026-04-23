import {
  artifact,
  defineTool,
  firstNonEmptyString,
  optionalArtifact,
} from "@runxhq/authoring";

export default defineTool({
  name: "sourcey.package",
  description: "Package a completed Sourcey run into a reusable Sourcey packet.",
  output: {
    packet: "runx.sourcey.packet.v1",
    wrap_as: "sourcey_packet",
  },
  scopes: ["sourcey.verify"],
  inputs: {
    discovery_report: artifact({ description: "Discovery report emitted by the Sourcey discover step." }),
    doc_bundle: artifact({ description: "Doc bundle emitted by the Sourcey author step." }),
    project_brief: optionalArtifact({ description: "Optional grounded brief supplied to the Sourcey run." }),
    sourcey_build_report: artifact({ description: "Sourcey build report emitted by sourcey.build." }),
    evaluation_report: artifact({ description: "Evaluation report emitted by the critique step." }),
    revision_bundle: artifact({ description: "Revision bundle emitted by the revise step." }),
    sourcey_verification_report: artifact({ description: "Verification report emitted by sourcey.verify." }),
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
