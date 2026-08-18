const fs = require("node:fs");
const path = require("node:path");

const tracked = fs.readFileSync(0, "utf8").split(/\0|\r?\n/).filter(Boolean);
if (!tracked.length) throw new Error("No tracked-file inventory received; run through npm run check:privacy.");
const forbiddenTracked = tracked.filter((file) => fs.existsSync(file) && (
  /^(?:\.codex|\.claude)(?:\/|$)/.test(file)
  || /^sessions\/(?![^/]+\.example\.(?:json|toml)$)/.test(file)
  || /^release-notes-preview\.html$/.test(file)
  || /^(?:playwright-report|coverage)(?:\/|$)/.test(file)
  || /^tests\/(?:e2e|validation)\/results\/(?!\.gitignore$)/.test(file)
));
if (forbiddenTracked.length) throw new Error(`Private/generated files are tracked:\n${forbiddenTracked.join("\n")}`);

const root = path.resolve(process.env.DIST_DIR || "dist");
// REL-02 / AD-8: the build (vite.config.js writeBundle()) intentionally ships
// dist/sessions/phasefinder_local.json as an inert `{}` autoload stub so the
// startup probe (js/session/core.js try_autoload()) gets 200 {} instead of a
// 404. scripts/verify-dist.cjs is the strong guard for this path -- it fails
// the build unless the stub's content is exactly `{}` AND it is the only
// entry in dist/sessions/. This script does not duplicate that content check;
// it only needs to stop treating the one known-safe, content-verified path as
// a bare-name match so `npm run check` (which runs check:privacy again after
// build && check:dist) can pass. Everything else under sessions/ -- including
// a real session reusing this exact filename, which verify-dist.cjs already
// rejects earlier in the pipeline -- is still caught by the pattern checks
// below (they still run against this file's own text content, and by every
// other file's relative path).
const AUTOLOAD_STUB = "sessions/phasefinder_local.json";
if (fs.existsSync(root)) {
  const textExtensions = new Set([".html", ".js", ".css", ".json", ".txt", ".xml", ".webmanifest"]);
  const findings = [];
  const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(target);
    const relative = path.relative(root, target).replaceAll(path.sep, "/");
    if (relative !== AUTOLOAD_STUB && /(^|\/)(?:sessions|tests|\.codex|\.claude|\.git)(\/|$)|\.fcs$|\.toml$/i.test(relative)) findings.push(relative);
    if (!textExtensions.has(path.extname(entry.name).toLowerCase()) && entry.name !== "site.webmanifest") return;
    const text = fs.readFileSync(target, "utf8");
    if (/(?:\/home\/[^/\s]+|\/Users\/[^/\s]+|[A-Z]:\\Users\\[^\\\s]+)/.test(text)) findings.push(`${relative}: local absolute path`);
    if (/\bopfs[_-]?(?:id|key)\s*[=:]\s*["'][A-Za-z0-9_-]{8,}/i.test(text)) findings.push(`${relative}: OPFS identifier`);
    for (const match of text.matchAll(/\b[A-Za-z0-9][A-Za-z0-9_.-]{2,}\.fcs\b/gi)) {
      if (!/E2E/i.test(match[0])) findings.push(`${relative}: non-synthetic FCS sample name ${match[0]}`);
    }
  });
  walk(root);
  if (findings.length) throw new Error(`Private material entered the deployable artifact:\n${[...new Set(findings)].join("\n")}`);
}
console.log(`Privacy scan passed (${tracked.length} tracked paths${fs.existsSync(root) ? "; dist inspected" : ""}).`);
