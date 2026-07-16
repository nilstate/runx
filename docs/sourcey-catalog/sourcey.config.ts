import { defineConfig, markdown } from "sourcey";

export default defineConfig({
  name: "Runx Governed Skill Catalog",
  siteUrl: "https://github.com",
  baseUrl: "/runxhq/runx",
  repo: "https://github.com/runxhq/runx",
  editBranch: "main",
  editBasePath: "docs/sourcey-catalog",
  theme: {
    preset: "default",
    colors: { primary: "#0f766e", light: "#14b8a6", dark: "#134e4a" },
  },
  navigation: {
    tabs: [
      {
        tab: "Skills",
        slug: "",
        source: markdown({
          groups: [
            {
              group: "Introduction",
              pages: ["pages/introduction"],
            },
            {
              group: "Operate",
              pages: ["pages/agency", "pages/business-ops", "pages/operator-inbox", "pages/ops-desk", "pages/work-plan"],
            },
            {
              group: "Research and data",
              pages: ["pages/deep-research", "pages/research", "pages/data-store", "pages/knowledge-router", "pages/web-fetch"],
            },
            {
              group: "GitHub and delivery",
              pages: ["pages/github-sync", "pages/issue-intake", "pages/issue-triage", "pages/issue-to-pr", "pages/release"],
            },
            {
              group: "Safety and review",
              pages: ["pages/audit-receipt", "pages/cve-audit", "pages/least-privilege", "pages/policy-author", "pages/review-receipt", "pages/sandbox-harden"],
            },
            {
              group: "Outbound and tooling",
              pages: ["pages/governed-outbound", "pages/run-history", "pages/sourcey"],
            },
          ],
        }),
      },
    ],
  },
});
