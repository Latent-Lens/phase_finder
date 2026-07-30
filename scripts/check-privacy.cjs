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
if (fs.existsSync(root)) {
  const textExtensions = new Set([".html", ".js", ".css", ".json", ".txt", ".xml", ".webmanifest"]);
  const findings = [];
  const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(target);
    const relative = path.relative(root, target).replaceAll(path.sep, "/");
    if (/(^|\/)(?:sessions|tests|\.codex|\.claude|\.git)(\/|$)|\.fcs$|\.toml$/i.test(relative)) findings.push(relative);
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
