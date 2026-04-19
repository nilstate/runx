export default {
  name: "Sourcey Fixture",
  repo: "https://github.com/sourcey/sourcey-basic-fixture",
  ogImage: "https://sourcey.example.test/og.png",
  navigation: {
    tabs: [
      {
        tab: "Guides",
        groups: [
          {
            group: "Start",
            pages: ["introduction"],
          },
        ],
      },
      {
        tab: "API",
        openapi: "./openapi.yaml",
      },
      {
        tab: "MCP",
        mcp: "./mcp.json",
      },
    ],
  },
};
