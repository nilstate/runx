import { describe, expect, it } from "vitest";

import {
  isGithubRepoUrl,
  publishUrlSkill,
  renderUrlAddResult,
  resolveUrlAddApiBaseUrl,
  UrlAddCliError,
  type UrlAddIndexResult,
} from "./url-add.js";

describe("isGithubRepoUrl", () => {
  it("matches bare github.com paths", () => {
    expect(isGithubRepoUrl("github.com/kam/skills")).toBe(true);
  });

  it("matches https URLs", () => {
    expect(isGithubRepoUrl("https://github.com/kam/skills")).toBe(true);
  });

  it("rejects registry-id form", () => {
    expect(isGithubRepoUrl("@kam/skills")).toBe(false);
    expect(isGithubRepoUrl("kam/skills")).toBe(false);
  });

  it("rejects non-github urls", () => {
    expect(isGithubRepoUrl("https://gitlab.com/kam/skills")).toBe(false);
  });

  it("rejects empty input", () => {
    expect(isGithubRepoUrl("")).toBe(false);
  });
});

describe("resolveUrlAddApiBaseUrl", () => {
  it("falls back to runx.ai", () => {
    expect(resolveUrlAddApiBaseUrl({})).toBe("https://runx.ai");
  });

  it("respects RUNX_PUBLIC_API_BASE_URL", () => {
    expect(resolveUrlAddApiBaseUrl({ RUNX_PUBLIC_API_BASE_URL: "https://api.dev/" })).toBe("https://api.dev/");
  });
});

describe("publishUrlSkill", () => {
  const successPayload: UrlAddIndexResult = {
    status: "success",
    listings: [
      {
        owner: "kam",
        name: "echo",
        skill_id: "kam/echo",
        version: "sha-abc",
        permalink: "https://runx.ai/x/kam/echo",
        trust_tier: "community",
        skill_path: "SKILL.md",
        digest_unchanged: false,
      },
    ],
    warnings: [],
    repo: { owner: "kam", repo: "skills", ref: "main", sha: "a".repeat(40) },
  };

  it("posts repo_url to the configured endpoint and returns the parsed payload", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: unknown;
    const result = await publishUrlSkill({
      repoUrl: "github.com/kam/skills",
      apiBaseUrl: "https://api.runx.test",
      fetcher: async (url, init) => {
        capturedUrl = url;
        capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
        return new Response(JSON.stringify(successPayload), { status: 200 });
      },
    });

    expect(capturedUrl).toBe("https://api.runx.test/v1/index");
    expect(capturedBody).toEqual({ repo_url: "github.com/kam/skills" });
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0].skill_id).toBe("kam/echo");
  });

  it("passes an optional git ref through to the index endpoint", async () => {
    let capturedBody: unknown;
    await publishUrlSkill({
      repoUrl: "github.com/kam/skills",
      ref: "feature/index-me",
      apiBaseUrl: "https://api.runx.test",
      fetcher: async (_url, init) => {
        capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
        return new Response(JSON.stringify(successPayload), { status: 200 });
      },
    });

    expect(capturedBody).toEqual({ repo_url: "github.com/kam/skills", ref: "feature/index-me" });
  });

  it("throws UrlAddCliError with the parsed error payload on non-2xx", async () => {
    await expect(
      publishUrlSkill({
        repoUrl: "github.com/spam/repo",
        apiBaseUrl: "https://api.runx.test",
        fetcher: async () =>
          new Response(
            JSON.stringify({ status: "error", error: { code: "rate_limited", detail: "slow down" } }),
            { status: 429 },
          ),
      }),
    ).rejects.toMatchObject({ payload: { code: "rate_limited", detail: "slow down" } });
  });

  it("falls back to a generic http_error when the response body is unparseable", async () => {
    await expect(
      publishUrlSkill({
        repoUrl: "github.com/spam/repo",
        apiBaseUrl: "https://api.runx.test",
        fetcher: async () => new Response("<html>500</html>", { status: 500 }),
      }),
    ).rejects.toBeInstanceOf(UrlAddCliError);
  });

  it("falls back to a generic http_error when the error body is JSON but not the expected shape", async () => {
    await expect(
      publishUrlSkill({
        repoUrl: "github.com/spam/repo",
        apiBaseUrl: "https://api.runx.test",
        fetcher: async () => new Response("null", { status: 500 }),
      }),
    ).rejects.toMatchObject({ payload: { code: "http_error" } });
  });

  it("throws invalid_response when a 200 returns a non-success payload", async () => {
    await expect(
      publishUrlSkill({
        repoUrl: "github.com/kam/skills",
        apiBaseUrl: "https://api.runx.test",
        fetcher: async () => new Response("null", { status: 200 }),
      }),
    ).rejects.toMatchObject({ payload: { code: "invalid_response" } });
  it("throws invalid_response when a 200 returns missing warnings or repo", async () => {
    await expect(
      publishUrlSkill({
        repoUrl: "github.com/kam/skills",
        apiBaseUrl: "https://api.runx.test",
        fetcher: async () => new Response(JSON.stringify({ status: "success", listings: [] }), { status: 200 }),
      }),
    ).rejects.toMatchObject({ payload: { code: "invalid_response" } });
  });
});

describe("renderUrlAddResult", () => {
  it("renders one listing with permalink, install, and run hints", () => {
    const text = renderUrlAddResult({
      status: "success",
      listings: [
        {
          owner: "kam",
          name: "echo",
          skill_id: "kam/echo",
          version: "sha-abc",
          permalink: "https://runx.ai/x/kam/echo",
          trust_tier: "community",
          skill_path: "SKILL.md",
          digest_unchanged: false,
        },
      ],
      warnings: [],
      repo: { owner: "kam", repo: "skills", ref: "main", sha: "a".repeat(40) },
    });
    expect(text).toContain("indexed 1 skill from kam/skills@");
    expect(text).toContain("kam/echo@sha-abc");
    expect(text).toContain("https://runx.ai/x/kam/echo");
    expect(text).toContain("runx add kam/echo@sha-abc");
    expect(text).toContain("runx skill kam/echo@sha-abc");
    expect(text).not.toContain("runx echo");
    expect(text).not.toContain("runx claim");
  });

  it("flags unchanged reindexes and surfaces warnings", () => {
    const text = renderUrlAddResult({
      status: "success",
      listings: [
        {
          owner: "kam",
          name: "echo",
          skill_id: "kam/echo",
          version: "sha-abc",
          permalink: "https://runx.ai/x/kam/echo",
          trust_tier: "community",
          skill_path: "SKILL.md",
          digest_unchanged: true,
        },
      ],
      warnings: [
        { skill_path: "skills/bad/SKILL.md", code: "skill_md_invalid", detail: "frontmatter missing" },
      ],
      repo: { owner: "kam", repo: "skills", ref: "main", sha: "a".repeat(40) },
    });
    expect(text).toContain("(unchanged)");
    expect(text).toContain("skill_md_invalid");
    expect(text).toContain("frontmatter missing");
  });
});
