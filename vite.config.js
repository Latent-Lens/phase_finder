const path = require("node:path");
const fs = require("node:fs");
const { defineConfig } = require("vite");
let outDir = path.resolve("dist");
let base = "/";

module.exports = defineConfig({
  base: process.env.BASE_PATH || "/",
  plugins: [{
    name: "copy-stable-runtime-assets",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      base = config.base;
    },
    closeBundle() {
      fs.cpSync("assets/img/favicon", path.join(outDir, "assets/img/favicon"), { recursive: true });
      const indexPath = path.join(outDir, "index.html");
      const index = fs.readFileSync(indexPath, "utf8").replace(
        /href="[^"]*site-[^"]*\.webmanifest"/,
        `href="${base}assets/img/favicon/site.webmanifest"`,
      );
      fs.writeFileSync(indexPath, index);
      for (const file of fs.readdirSync(path.join(outDir, "assets"))) {
        if (/^site-.*\.webmanifest$/.test(file)) fs.unlinkSync(path.join(outDir, "assets", file));
      }
    },
  }],
  resolve: {
    alias: {
      // Keep production builds on the same vendored, offline D3 bundle used
      // by the browser import map during build-free development.
      d3: path.resolve(__dirname, "js/vendor/d3.min.js"),
    },
  },
  build: {
    rollupOptions: {
      // help.html is a second HTML entry: the app links to it ("Get Help"), so
      // it (and its stylesheet/images) must be emitted into the build, not just
      // served from the source tree during build-free development.
      input: {
        main: path.resolve(__dirname, "index.html"),
        help: path.resolve(__dirname, "help.html"),
      },
    },
  },
});
