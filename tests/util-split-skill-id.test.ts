import { describe, expect, it } from "vitest";

import { splitSkillId } from "../packages/core/src/registry/store.js";

describe("splitSkillId enforces exactly two non-empty segments", () => {
  it("splits owner/name into [owner, name]", () => {
    expect(splitSkillId("acme/widget")).toEqual(["acme", "widget"]);
  });

  it("rejects ids with more than one slash", () => {
    expect(() => splitSkillId("acme/widget/extra")).toThrow(/Invalid registry skill id/);
  });

  it("rejects ids without a slash", () => {
    expect(() => splitSkillId("widget")).toThrow(/Invalid registry skill id/);
  });

  it("rejects ids with an empty owner", () => {
    expect(() => splitSkillId("/widget")).toThrow(/Invalid registry skill id/);
  });

  it("rejects ids with an empty name", () => {
    expect(() => splitSkillId("acme/")).toThrow(/Invalid registry skill id/);
  });
});
