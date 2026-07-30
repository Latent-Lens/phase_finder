const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(process.env.DIST_DIR || "dist");
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const pkg = require("../package.json");
function localCommit() {
  const head = fs.readFileSync(".git/HEAD", "utf8").trim();
  if (!head.startsWith("ref: ")) return head;
  const ref = head.slice(5);
  if (fs.existsSync(path.join(".git", ref))) return fs.readFileSync(path.join(".git", ref), "utf8").trim();
  return fs.readFileSync(".git/packed-refs", "utf8").split("\n").find((line) => line.endsWith(` ${ref}`))?.split(" ")[0] || "unknown";
}
const sourceCommit = process.env.GITHUB_SHA || localCommit();
const npmVersion = process.env.npm_config_user_agent?.match(/\bnpm\/([^ ]+)/)?.[1]
  || pkg.packageManager?.split("@")[1] || "unknown";
const metadata = {
  application: "PhaseFinder",
  version: pkg.version,
  sourceCommit,
  sourceTag: process.env.RELEASE_TAG || null,
  builtAt: new Date().toISOString(),
  toolchain: { node: process.version, npm: npmVersion, python: process.env.PYTHON_VERSION || "3.12" },
};
fs.writeFileSync(path.join(root, "build-metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
const components = Object.entries(lock.packages || {}).filter(([name]) => name).map(([name, pkg]) => ({
  type: "library", name: name.replace(/^node_modules\//, ""), version: pkg.version,
  licenses: pkg.license ? [{ license: { id: pkg.license } }] : undefined,
}));
fs.writeFileSync(path.join(root, "sbom.cdx.json"), JSON.stringify({
  bomFormat: "CycloneDX", specVersion: "1.5", version: 1,
  metadata: { component: { type: "application", name: "PhaseFinder", version: metadata.version } }, components,
}, null, 2) + "\n");
const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target);
    else if (entry.isFile() && !["SHA256SUMS", "artifact-manifest.json"].includes(entry.name)) files.push(target);
  }
}
walk(root);
const artifactManifest = files.sort().map(file => ({
  path: path.relative(root, file).replaceAll(path.sep, "/"),
  bytes: fs.statSync(file).size,
  sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
}));
fs.writeFileSync(path.join(root, "artifact-manifest.json"), JSON.stringify({ version: 1, files: artifactManifest }, null, 2) + "\n");
files.push(path.join(root, "artifact-manifest.json"));
fs.writeFileSync(path.join(root, "SHA256SUMS"), files.sort().map(file =>
  `${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}  ${path.relative(root, file).replaceAll(path.sep, "/")}`
).join("\n") + "\n");
console.log(`Generated provenance for ${files.length} production files at ${sourceCommit}.`);
