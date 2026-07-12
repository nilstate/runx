export default {
  name: "runx",
  siteUrl: "https://raw.githubusercontent.com",
  baseUrl: "/6pt6brty57-star/runx/codex/sourcey-llms/sourcey-docs",
  repo: "https://github.com/runxhq/runx",
  editBranch: "main",
  prettyUrls: false,
  changelog: false,
  navigation: {
    tabs: [
      {
        tab: "Documentation",
        groups: [
          {
            group: "Start Here",
            pages: [
              "README.md",
              "docs/getting-started.md",
              "docs/agent-skills.md",
            ],
          },
          {
            group: "Operate",
            pages: [
              "docs/operator-skills.md",
              "docs/issue-to-pr.md",
              "docs/publishing.md",
            ],
          },
          {
            group: "Reference",
            pages: ["docs/how-we-test.md", "docs/reference.md"],
          },
        ],
      },
    ],
  },
};
