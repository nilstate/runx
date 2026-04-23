import { describe, expect, it } from "vitest";

import { RUNX_CONTRACT_IDS, RUNX_LOGICAL_SCHEMAS, runxContractSchemas } from "./index.js";

describe("@runxhq/contracts", () => {
  it("exports stable runx logical schema identifiers", () => {
    expect(RUNX_LOGICAL_SCHEMAS.doctor).toBe("runx.doctor.v1");
    expect(RUNX_LOGICAL_SCHEMAS.receipt).toBe("runx.receipt.v1");
  });

  it("uses durable schema URI ids", () => {
    expect(RUNX_CONTRACT_IDS.toolManifest).toBe("https://schemas.runx.dev/runx/tool/manifest/v1.json");
    expect(runxContractSchemas.toolManifest.$id).toBe(RUNX_CONTRACT_IDS.toolManifest);
  });

  it("keeps fixture lanes aligned with authoring plan", () => {
    const lane = runxContractSchemas.fixture.properties?.lane;
    expect(lane?.enum).toEqual(["deterministic", "agent", "repo-integration"]);
  });
});
