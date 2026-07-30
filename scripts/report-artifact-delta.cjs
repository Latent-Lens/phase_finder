const fs = require("node:fs");

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) throw new Error("Usage: report-artifact-delta.cjs <base-manifest> <current-manifest>");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8")).files;
const summarize = (files) => ({
  files: files.length,
  bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  js: files.filter((file) => file.path.endsWith(".js")).reduce((sum, file) => sum + file.bytes, 0),
  css: files.filter((file) => file.path.endsWith(".css")).reduce((sum, file) => sum + file.bytes, 0),
  images: files.filter((file) => /\.(?:png|jpe?g|webp|gif|svg|ico)$/i.test(file.path)).reduce((sum, file) => sum + file.bytes, 0),
});
const before = summarize(read(beforePath));
const after = summarize(read(afterPath));
const rows = Object.keys(after).map((key) => `| ${key} | ${before[key]} | ${after[key]} | ${after[key] - before[key]} |`);
const report = ["## Production artifact size delta", "", "| Metric | Base | Current | Delta |", "| --- | ---: | ---: | ---: |", ...rows, ""].join("\n");
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
