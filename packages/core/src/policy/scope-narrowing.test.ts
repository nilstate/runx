import { describe, expect, it } from "vitest";

import {
  admitGraphStepScopes,
  type GraphScopeAdmissionDecision,
  type GraphScopeAdmissionRequest,
} from "./index.js";

/**
 * Flagship test for runx's "trust every hop" promise: scope narrowing
 * across graph edges must allow strict subsets of the parent grant and
 * deny anything outside it. If a future change accidentally widens
 * scope, this file should be the first thing that breaks.
 *
 * Public API under test: `admitGraphStepScopes(request)`.
 *
 * The matching rule (defined in `scopeAllows`):
 *   - exact-match grant covers an exact-match request
 *   - the wildcard grant `*` covers any requested scope
 *   - a prefix wildcard grant of the form `prefix:*` covers any
 *     request that starts with `prefix:`
 *   - nothing else covers the request
 */

function admit(
  request: Partial<GraphScopeAdmissionRequest> & {
    requestedScopes: readonly string[];
    grantScopes: readonly string[];
    grantId?: string;
    stepId?: string;
  },
): GraphScopeAdmissionDecision {
  return admitGraphStepScopes({
    stepId: request.stepId ?? "step-under-test",
    requestedScopes: request.requestedScopes,
    grant: { scopes: request.grantScopes, grant_id: request.grantId },
  });
}

describe("scope narrowing across graph edges", () => {
  describe("allow paths", () => {
    it("allows when requested scopes are a strict subset of granted scopes", () => {
      const decision = admit({
        requestedScopes: ["repo:read"],
        grantScopes: ["repo:read", "repo:write", "ci:trigger"],
      });
      expect(decision.status).toBe("allow");
      expect(decision.requestedScopes).toEqual(["repo:read"]);
      expect(decision.grantedScopes).toEqual(["repo:read", "repo:write", "ci:trigger"]);
    });

    it("allows when requested scopes equal granted scopes (exact match set)", () => {
      const decision = admit({
        requestedScopes: ["repo:read", "repo:write"],
        grantScopes: ["repo:read", "repo:write"],
      });
      expect(decision.status).toBe("allow");
    });

    it("allows when no scopes are requested (vacuous narrowing)", () => {
      const decision = admit({
        requestedScopes: [],
        grantScopes: ["repo:read"],
      });
      expect(decision.status).toBe("allow");
      expect(decision.reasons).toContain("graph step requested no scopes");
    });

    it("allows any requested scope under a wildcard grant `*`", () => {
      const decision = admit({
        requestedScopes: ["repo:read", "ci:trigger", "deploy:prod"],
        grantScopes: ["*"],
      });
      expect(decision.status).toBe("allow");
      expect(decision.grantedScopes).toEqual(["*"]);
    });

    it("allows any matching scope under a prefix wildcard grant `prefix:*`", () => {
      const decision = admit({
        requestedScopes: ["repo:read", "repo:write", "repo:branch:create"],
        grantScopes: ["repo:*"],
      });
      expect(decision.status).toBe("allow");
    });

    it("deduplicates requested scopes in the decision", () => {
      const decision = admit({
        requestedScopes: ["repo:read", "repo:read", "repo:read"],
        grantScopes: ["repo:read"],
      });
      expect(decision.status).toBe("allow");
      expect(decision.requestedScopes).toEqual(["repo:read"]);
    });

    it("deduplicates granted scopes in the decision", () => {
      const decision = admit({
        requestedScopes: ["repo:read"],
        grantScopes: ["repo:read", "repo:read", "repo:write"],
      });
      expect(decision.status).toBe("allow");
      expect(decision.grantedScopes).toEqual(["repo:read", "repo:write"]);
    });
  });

  describe("deny paths", () => {
    it("denies when a requested scope is not in granted scopes (widening)", () => {
      const decision = admit({
        requestedScopes: ["repo:read", "repo:delete"],
        grantScopes: ["repo:read"],
      });
      expect(decision.status).toBe("deny");
      const reason = decision.reasons.join(" ");
      expect(reason).toContain("repo:delete");
      expect(reason).toContain("outside graph grant");
    });

    it("denies when the requested scope set is disjoint from granted scopes", () => {
      const decision = admit({
        requestedScopes: ["secrets:read"],
        grantScopes: ["repo:read", "ci:trigger"],
      });
      expect(decision.status).toBe("deny");
      expect(decision.reasons.join(" ")).toContain("secrets:read");
    });

    it("denies any non-empty request when the grant is empty", () => {
      const decision = admit({
        requestedScopes: ["repo:read"],
        grantScopes: [],
      });
      expect(decision.status).toBe("deny");
      expect(decision.grantedScopes).toEqual([]);
    });

    it("denies a request that exceeds a prefix wildcard's prefix", () => {
      const decision = admit({
        requestedScopes: ["secrets:read"],
        grantScopes: ["repo:*"],
      });
      expect(decision.status).toBe("deny");
    });

    it("denies even one widening scope inside an otherwise-allowed set", () => {
      const decision = admit({
        requestedScopes: ["repo:read", "repo:write", "deploy:prod"],
        grantScopes: ["repo:*"],
      });
      expect(decision.status).toBe("deny");
      expect(decision.reasons.join(" ")).toContain("deploy:prod");
    });

    it("does not allow a prefix wildcard request like `repo:*` against an exact grant `repo:read`", () => {
      // The matcher only allows prefix wildcards on the GRANT side, not the request side.
      // A request for `repo:*` must literally appear in (or be covered by) the grant.
      const decision = admit({
        requestedScopes: ["repo:*"],
        grantScopes: ["repo:read"],
      });
      expect(decision.status).toBe("deny");
    });
  });

  describe("decision shape", () => {
    it("carries stepId, requestedScopes, grantedScopes, and grantId through allow decisions", () => {
      const decision = admit({
        stepId: "deploy-step",
        requestedScopes: ["repo:read"],
        grantScopes: ["repo:read", "repo:write"],
        grantId: "grant_42",
      });
      expect(decision).toMatchObject({
        status: "allow",
        stepId: "deploy-step",
        requestedScopes: ["repo:read"],
        grantedScopes: ["repo:read", "repo:write"],
        grantId: "grant_42",
      });
      expect(decision.reasons).toEqual(expect.any(Array));
    });

    it("carries stepId, requestedScopes, grantedScopes, and grantId through deny decisions", () => {
      const decision = admit({
        stepId: "deploy-step",
        requestedScopes: ["repo:delete"],
        grantScopes: ["repo:read"],
        grantId: "grant_42",
      });
      expect(decision).toMatchObject({
        status: "deny",
        stepId: "deploy-step",
        requestedScopes: ["repo:delete"],
        grantedScopes: ["repo:read"],
        grantId: "grant_42",
      });
      expect(decision.reasons.length).toBeGreaterThan(0);
    });

    it("omits grantId when the grant carries no grant_id", () => {
      const decision = admit({
        requestedScopes: ["repo:read"],
        grantScopes: ["repo:read"],
      });
      expect(decision.grantId).toBeUndefined();
    });

    it("returns a different reason text for empty-request vs non-empty allow paths", () => {
      const empty = admit({ requestedScopes: [], grantScopes: ["*"] });
      const nonEmpty = admit({ requestedScopes: ["repo:read"], grantScopes: ["*"] });
      expect(empty.reasons).not.toEqual(nonEmpty.reasons);
    });
  });

  describe("identity flow (parent grant -> decision.grantedScopes)", () => {
    it("preserves grant.scopes verbatim (after deduplication) in decision.grantedScopes", () => {
      const granted = ["repo:read", "repo:write", "ci:trigger"] as const;
      const decision = admit({
        requestedScopes: ["repo:read"],
        grantScopes: granted,
      });
      expect(decision.grantedScopes).toEqual(granted);
    });

    it("does not silently widen grantedScopes beyond the grant", () => {
      const decision = admit({
        requestedScopes: ["repo:read"],
        grantScopes: ["repo:read"],
      });
      // The trust pitch: the decision's grantedScopes never grows past the grant's scopes.
      expect(decision.grantedScopes.length).toBeLessThanOrEqual(["repo:read"].length);
      expect(decision.grantedScopes).not.toContain("repo:write");
      expect(decision.grantedScopes).not.toContain("*");
    });
  });
});
