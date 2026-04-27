import { describe, expect, it } from "vitest";

import { resolveOutputPath, type GraphStepOutput } from "./graph-context.js";

function makeOutput(): GraphStepOutput {
  return {
    status: "success",
    stdout: "{\"schema\":\"runx.fs.write_bundle.v1\"}",
    stderr: "",
    receiptId: "rx_test",
    fields: {
      file_bundle_write: {
        type: "file_bundle_write",
        version: "1",
        data: {
          schema: "runx.fs.write_bundle.v1",
          data: {
            files: [
              {
                path: "docs/index.md",
              },
            ],
          },
        },
        meta: {
          artifact_id: "ax_test",
          run_id: "gx_test",
        },
      },
      data: {
        schema: "runx.fs.write_bundle.v1",
        data: {
          files: [
            {
              path: "docs/index.md",
            },
          ],
        },
      },
      raw: "{\"schema\":\"runx.fs.write_bundle.v1\"}",
    },
    artifactIds: ["ax_test"],
    artifacts: [],
  };
}

describe("resolveOutputPath", () => {
  it("preserves legacy field access for packet-wrapped artifacts", () => {
    const files = resolveOutputPath(makeOutput(), "file_bundle_write.data.files");

    expect(files).toEqual([
      {
        path: "docs/index.md",
      },
    ]);
  });

  it("still supports explicit packet traversal", () => {
    const files = resolveOutputPath(makeOutput(), "file_bundle_write.data.data.files");

    expect(files).toEqual([
      {
        path: "docs/index.md",
      },
    ]);
  });
});
