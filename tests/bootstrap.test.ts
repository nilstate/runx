import { describe, expect, it } from "vitest";

import { cliPackage } from "../packages/cli/src/index.js";
import { parserPackage } from "@runxhq/core/parser";
import { runnerLocalPackage } from "@runxhq/core/runner-local";

describe("bootstrap workspace", () => {
  it("wires trusted-kernel package exports", () => {
    expect([cliPackage, parserPackage, runnerLocalPackage]).toEqual([
      "@runxhq/cli",
      "@runxhq/core/parser",
      "@runxhq/core/runner-local",
    ]);
  });
});
