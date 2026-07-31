const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { defineConfig } = require("vite");
const pkg = require("./package.json");
let outDir = path.resolve("dist");
let base = "/";

function sourceCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (_) {
    return "unknown";
  }
}

module.exports = defineConfig({
  base: process.env.BASE_PATH || "/",
  define: {
    __PHASEFINDER_VERSION__: JSON.stringify(pkg.version),
    __PHASEFINDER_SOURCE_COMMIT__: JSON.stringify(sourceCommit()),
  },
  plugins: [{
    name: "copy-stable-runtime-assets",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      base = config.base;
    },
    writeBundle() {
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
      // The app and help center are plain HTML entries. Listing the help pages
      // here keeps their relative links working in root and subpath builds.
      input: {
        main: path.resolve(__dirname, "index.html"),
        help: path.resolve(__dirname, "help/index.html"),
        helpGettingStarted: path.resolve(__dirname, "help/help-getting-started.html"),
        helpMetadata: path.resolve(__dirname, "help/help-metadata.html"),
        helpPlotting: path.resolve(__dirname, "help/help-plotting.html"),
        helpModeling: path.resolve(__dirname, "help/help-modeling.html"),
        helpCellCycleMathCheck: path.resolve(__dirname, "help/help-cell-cycle-math-check.html"),
        helpCellCycleAccuracy: path.resolve(__dirname, "help/help-cell-cycle-accuracy.html"),
        helpStatistics: path.resolve(__dirname, "help/help-statistics.html"),
        helpSessions: path.resolve(__dirname, "help/help-sessions.html"),
        helpTroubleshooting: path.resolve(__dirname, "help/help-troubleshooting.html"),
      },
    },
  },
});
