const path = require("node:path");
const { defineConfig } = require("vite");

module.exports = defineConfig({
  resolve: {
    alias: {
      // Keep production builds on the same vendored, offline D3 bundle used
      // by the browser import map during build-free development.
      d3: path.resolve(__dirname, "js/vendor/d3.min.js"),
    },
  },
});
