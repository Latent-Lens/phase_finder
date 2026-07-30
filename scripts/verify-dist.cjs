const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");

const root = path.resolve(process.env.DIST_DIR || "dist");
const configuredBase = (process.env.BASE_PATH || "/").replace(/^\/+|\/+$/g, "");
const basePath = configuredBase ? `/${configuredBase}/` : "/";
const required = [
  "index.html", "help/index.html", "_headers",
  "artifact-manifest.json", "build-metadata.json", "sbom.cdx.json", "SHA256SUMS",
  "assets/img/favicon/site.webmanifest",
  "assets/img/favicon/android-chrome-192x192.png",
  "assets/img/favicon/android-chrome-512x512.png",
];
const forbidden = ["sessions", "tests", ".codex", ".claude", ".git"];

if (!fs.existsSync(root)) throw new Error("dist/ does not exist; run npm run build first.");
for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing production artifact: ${file}`);
}
for (const name of forbidden) {
  if (fs.existsSync(path.join(root, name))) throw new Error(`Private/internal path entered dist: ${name}`);
}

const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
const headers = fs.readFileSync(path.join(root, "_headers"), "utf8");
const importMap = indexHtml.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1];
if (!importMap) throw new Error("Production index has no import map to authorize in CSP.");
const importMapHash = require("node:crypto").createHash("sha256").update(importMap).digest("base64");
for (const requiredHeader of [
  `Content-Security-Policy:`, `'sha256-${importMapHash}'`, `worker-src 'self' blob:`,
  "X-Content-Type-Options: nosniff", "Referrer-Policy:", "X-Frame-Options:", "Permissions-Policy:",
  "Cache-Control: public, max-age=31536000, immutable",
  "Cache-Control: public, max-age=0, must-revalidate",
]) {
  if (!headers.includes(requiredHeader)) throw new Error(`Missing production security header: ${requiredHeader}`);
}

const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target);
    else if (entry.isFile()) files.push(path.relative(root, target));
  }
}
walk(root);
for (const worker of ["data_worker", "copy_worker", "fit_worker", "cloccs_worker"]) {
  if (!files.some((file) => new RegExp(`^assets/${worker}-.*\\.js$`).test(file))) {
    throw new Error(`Missing production worker bundle: ${worker}`);
  }
}
const allowedExtensions = new Set(["", ".html", ".js", ".css", ".json", ".webmanifest", ".png", ".svg", ".ico", ".jpg", ".jpeg", ".webp", ".gif", ".txt"]);
const unexpected = files.filter((file) => !allowedExtensions.has(path.extname(file).toLowerCase()) || file.endsWith(".map"));
if (unexpected.length) throw new Error(`Unexpected production file type:\n${unexpected.join("\n")}`);
if (files.some((file) => /(^|\/)(phasefinder_local|phasefinder_session_)|\.fcs$/i.test(file))) {
  throw new Error("Personal session or FCS data entered dist.");
}
if (files.some((file) => /(^|\/)(\.env|.*\.log|.*\.toml)$/i.test(file))) {
  throw new Error("Private configuration, session, or log data entered dist.");
}

const normalizeTarget = (from, raw) => {
  const target = raw.split(/[?#]/, 1)[0];
  if (!target || /^(?:[a-z]+:|\/\/|#|data:|mailto:)/i.test(raw)) return null;
  if (target.startsWith("/")) {
    if (!target.startsWith(basePath)) throw new Error(`Root URL does not respect BASE_PATH ${basePath}: ${raw}`);
    return target.slice(basePath.length);
  }
  return path.posix.normalize(path.posix.join(path.posix.dirname(from), target));
};
const missing = [];
for (const file of files) {
  const extension = path.extname(file).toLowerCase();
  if (![".html", ".js", ".css", ".webmanifest"].includes(extension)) continue;
  const text = fs.readFileSync(path.join(root, file), "utf8");
  const references = extension === ".css"
    ? [...text.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/g)].map((match) => match[1])
    : extension === ".webmanifest"
      ? (JSON.parse(text).icons || []).map((icon) => icon.src)
      : extension === ".js"
        ? [...text.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/g)]
          .map((match) => match[1]).filter((reference) => reference.startsWith(".") || reference.startsWith("/"))
      : [...text.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)].map((match) => match[1]);
  for (const reference of references) {
    const target = normalizeTarget(file, reference);
    if (target && !fs.existsSync(path.join(root, target))) missing.push(`${file} -> ${reference}`);
  }
}
if (missing.length) throw new Error(`Broken local artifact references:\n${missing.join("\n")}`);

const manifest = JSON.parse(fs.readFileSync(path.join(root, "artifact-manifest.json"), "utf8"));
for (const item of manifest.files) {
  const target = path.join(root, item.path);
  if (!fs.existsSync(target) || fs.statSync(target).size !== item.bytes
      || crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex") !== item.sha256) {
    throw new Error(`Artifact manifest mismatch: ${item.path}`);
  }
}
const budgets = JSON.parse(fs.readFileSync("config/artifact-budgets.json", "utf8"));
const sizes = files.map((file) => ({ file, bytes: fs.statSync(path.join(root, file)).size }));
const largestJs = Math.max(0, ...sizes.filter(({ file }) => file.endsWith(".js")).map(({ bytes }) => bytes));
const cssBytes = sizes.filter(({ file }) => file.endsWith(".css")).reduce((sum, item) => sum + item.bytes, 0);
const largestImage = Math.max(0, ...sizes.filter(({ file }) => /\.(?:png|jpe?g|webp|gif|svg|ico)$/i.test(file)).map(({ bytes }) => bytes));
const totalBytes = sizes.reduce((sum, item) => sum + item.bytes, 0);
const totalGzip = files.reduce((sum, file) => sum + zlib.gzipSync(fs.readFileSync(path.join(root, file))).length, 0);
for (const [label, actual, budget] of [
  ["main JavaScript", largestJs, budgets.mainJavaScriptBytes],
  ["all CSS", cssBytes, budgets.allCssBytes],
  ["largest image", largestImage, budgets.largestImageBytes],
  ["total uncompressed", totalBytes, budgets.totalUncompressedBytes],
  ["total gzip", totalGzip, budgets.totalGzipBytes],
]) {
  if (actual > budget) throw new Error(`${label} budget exceeded: ${actual} > ${budget} bytes`);
  if (actual > budget * budgets.warningRatio) console.warn(`${label} budget warning: ${actual} / ${budget} bytes`);
}

console.log(`Verified ${files.length} production files; references, hashes, privacy rules, and artifact budgets passed.`);
