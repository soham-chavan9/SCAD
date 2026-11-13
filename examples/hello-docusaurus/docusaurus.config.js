// @ts-check
/** @type {import('@docusaurus/types').Config} */
const config = {
  title: "hello-docusaurus",
  url: "https://example.invalid",
  baseUrl: "/",
  onBrokenLinks: "throw",
  presets: [
    [
      "classic",
      {
        docs: { routeBasePath: "/" },
        blog: false,
        theme: {},
      },
    ],
  ],
};

module.exports = config;
