const fs = require("node:fs");

const requiredMajor = Number(fs.readFileSync(".nvmrc", "utf8").trim());
const actualMajor = Number(process.versions.node.split(".")[0]);
if (actualMajor !== requiredMajor) {
  console.error(`PhaseFinder requires Node ${requiredMajor}.x; found ${process.version}. Run \"nvm use\" (or install Node ${requiredMajor}) and retry.`);
  process.exit(1);
}
console.log(`Toolchain preflight passed: Node ${process.version}.`);
