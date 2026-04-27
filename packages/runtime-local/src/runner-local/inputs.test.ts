import { describe, expect, it } from "vitest";

import { materializeDeclaredInputs } from "./inputs.js";

describe("materializeDeclaredInputs", () => {
  it("applies explicit inputs over defaults", () => {
    const inputs = materializeDeclaredInputs({
      branch: {
        type: "string",
        required: false,
        default: "main",
      },
      title: {
        type: "string",
        required: false,
      },
    }, {
      title: "Refresh docs",
    });

    expect(inputs).toEqual({
      branch: "main",
      title: "Refresh docs",
    });
  });

  it("can unset inherited optional inputs explicitly", () => {
    const inputs = materializeDeclaredInputs({
      thread: {
        type: "json",
        required: false,
      },
      outbox_entry: {
        type: "json",
        required: false,
      },
    }, {
      thread: {
        $runx_unset: true,
      },
      outbox_entry: {
        entry_id: "pull_request:fixture",
      },
    });

    expect(inputs).toEqual({
      outbox_entry: {
        entry_id: "pull_request:fixture",
      },
    });
  });

  it("can clear a defaulted value with the unset directive", () => {
    const inputs = materializeDeclaredInputs({
      push_pr: {
        type: "boolean",
        required: false,
        default: true,
      },
    }, {
      push_pr: {
        $runx_unset: true,
      },
    });

    expect(inputs).toEqual({});
  });
});
