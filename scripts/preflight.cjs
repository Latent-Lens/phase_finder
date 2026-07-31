const fs = require("node:fs");

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));

const requiredMajor = Number(fs.readFileSync(".nvmrc", "utf8").trim());
const actualMajor = Number(process.versions.node.split(".")[0]);
if (actualMajor !== requiredMajor) {
  console.error(`PhaseFinder requires Node ${requiredMajor}.x; found ${process.version}. Run \"nvm use\" (or install Node ${requiredMajor}) and retry.`);
  process.exit(1);
}

if (pkg.version !== lock.version || pkg.version !== lock.packages?.[""]?.version) {
  console.error("PhaseFinder version mismatch between package.json and package-lock.json.");
  process.exit(1);
}
if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== `v${pkg.version}`) {
  console.error(`Release tag ${process.env.RELEASE_TAG} must match package version v${pkg.version}.`);
  process.exit(1);
}
if (pkg.license !== "PolyForm-Noncommercial-1.0.0"
    || !fs.readFileSync("LICENSE", "utf8").startsWith("# PolyForm Noncommercial License 1.0.0")
    || !fs.readFileSync("THIRD_PARTY_NOTICES.md", "utf8").includes("## D3 7.9.0")) {
  console.error("Package license, LICENSE, or third-party notice metadata is inconsistent.");
  process.exit(1);
}

console.log(`Toolchain preflight passed: PhaseFinder ${pkg.version}, Node ${process.version}.`);
