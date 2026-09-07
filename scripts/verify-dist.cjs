const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");

const root = path.resolve(process.env.DIST_DIR || "dist");
const configuredBase = (process.env.BASE_PATH || "/").replace(/^\/+|\/+$/g, "");
const basePath = configuredBase ? `/${configuredBase}/` : "/";
// The build ships this file as an inert `{}` so the startup autoload probe
// (js/session/core.js try_autoload()) gets 200 {} instead of a 404 (REL-02).
// It is the ONE path under sessions/ that is allowed to exist in dist/ --
// everything else that looks like session data is still forbidden below.
const AUTOLOAD_STUB = "sessions/phasefinder_local.json";
const required = [
  "index.html", "help/index.html", "_headers",
  "artifact-manifest.json", "build-metadata.json", "sbom.cdx.json", "SHA256SUMS",
  "assets/img/favicon/site.webmanifest",
  "assets/img/favicon/android-chrome-192x192.png",
  "assets/img/favicon/android-chrome-512x512.png",
  AUTOLOAD_STUB,
];
// "sessions" is intentionally NOT in this list any more: dist/sessions/ now
// legitimately exists to hold AUTOLOAD_STUB. Its content is verified below
// (must be exactly one empty-object file) instead of forbidding the directory
// outright.
const forbidden = ["tests", ".codex", ".claude", ".git"];

if (!fs.existsSync(root)) throw new Error("dist/ does not exist; run npm run build first.");
for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing production artifact: ${file}`);
}
for (const name of forbidden) {
  if (fs.existsSync(path.join(root, name))) throw new Error(`Private/internal path entered dist: ${name}`);
}

// A missing stub already failed the `required` loop above. Now make a real
// session leaking into the build (instead of the stub) a build failure too --
// this is the valuable half of REL-02.
const autoloadStub = JSON.parse(fs.readFileSync(path.join(root, AUTOLOAD_STUB), "utf8"));
if (Object.keys(autoloadStub).length) {
  throw new Error(`dist/${AUTOLOAD_STUB} must be an empty object; a real session leaked into the build.`);
}
const sessionsDirEntries = fs.readdirSync(path.join(root, "sessions"));
if (sessionsDirEntries.length !== 1 || sessionsDirEntries[0] !== path.basename(AUTOLOAD_STUB)) {
  throw new Error(`dist/sessions/ must contain only the known-safe autoload stub; found: ${sessionsDirEntries.join(", ") || "(nothing)"}`);
}

const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
const headers = fs.readFileSync(path.join(root, "_headers"), "utf8");
// REL-03: the import map only exists so the SOURCE tree runs unbuilt; Vite
// rewrites every bare "d3" import and never emits js/vendor/, so a build that
// still ships the map is dead markup kept alive only to justify a CSP
// script-src hash. Assert it is gone instead of hashing it.
if (/<script type="importmap">/.test(indexHtml)) {
  throw new Error("Production index still ships a dead import map; strip it at build time (REL-03, vite.config.js stripImportMap()).");
}
for (const requiredHeader of [
  `Content-Security-Policy:`, `worker-src 'self' blob:`,
  "X-Content-Type-Options: nosniff", "Referrer-Policy:", "X-Frame-Options:", "Permissions-Policy:",
  "Cache-Control: public, max-age=31536000, immutable",
  "Cache-Control: public, max-age=0, must-revalidate",
]) {
  if (!headers.includes(requiredHeader)) throw new Error(`Missing production security header: ${requiredHeader}`);
}
// With the import map gone, no inline script needs a CSP hash any more --
// script-src should be exactly 'self'. A hash reappearing here means either
// the map came back or a new inline script was added without review.
const cspLine = headers.split("\n").find((line) => line.includes("Content-Security-Policy:")) || "";
const scriptSrc = cspLine.match(/script-src ([^;]+)/)?.[1]?.trim();
if (!scriptSrc) throw new Error("Content-Security-Policy is missing a script-src directive.");
if (scriptSrc !== "'self'") {
  throw new Error(`script-src should be exactly 'self' now the import map is stripped (REL-03); found: ${scriptSrc}`);
}

const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target);
    // Every downstream check treats these as POSIX paths (regexes anchored on
    // "/", the artifact manifest, the required[]/forbidden[] lists above) --
    // path.relative() returns "\\"-joined paths on Windows, which silently
    // fails to match any of that, so normalize before recording.
    else if (entry.isFile()) files.push(path.relative(root, target).split(path.sep).join("/"));
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
// Narrowed for REL-02: AUTOLOAD_STUB is the one known-safe exception, and its
// content was already verified above to be exactly `{}`. Everything else
// matching a session or FCS filename pattern -- including a real session
// that happened to reuse this exact filename but with real keys, since the
// empty-object check above would already have failed the build for that
// case -- is still rejected.
if (files.some((file) => file !== AUTOLOAD_STUB && /(^|\/)(phasefinder_local|phasefinder_session_)|\.fcs$/i.test(file))) {
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
