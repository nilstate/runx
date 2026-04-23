import { describe, expect, it } from "vitest";

import { cliPackage } from "../packages/cli/src/index.js";
import { parserPackage } from "../packages/parser/src/index.js";
import { runnerLocalPackage } from "../packages/runner-local/src/index.js";

describe("bootstrap workspace", () => {
  it("wires trusted-kernel package exports", () => {
    expect([cliPackage, parserPackage, runnerLocalPackage]).toEqual([
      "@runxhq/cli",
      "@runx/parser",
      "@runx/runner-local",
    ]);
  });
});
