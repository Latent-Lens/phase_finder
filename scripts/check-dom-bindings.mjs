import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const walk = (directory) => readdirSync(directory).flatMap((name) => {
  const path = join(directory, name);
  return statSync(path).isDirectory() ? walk(path) : path.endsWith(".js") ? [path] : [];
});
const html = readFileSync("index.html", "utf8");
const staticIds = new Set([...html.matchAll(/\bid="([A-Za-z][\w:-]*)"/g)].map((match) => match[1]));
const dynamicIds = new Set(["select_all_files", "file_table_status", "djf_fit_table", "pf_tooltip"]);
const missing = new Map();
for (const file of walk("js")) {
  const source = readFileSync(file, "utf8");
  const patterns = [
    /querySelector(?:All)?\(\s*["']#([A-Za-z][\w:-]*)["']\s*\)/g,
    /getElementById\(\s*["']([A-Za-z][\w:-]*)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (!staticIds.has(match[1]) && !dynamicIds.has(match[1])) {
        const files = missing.get(match[1]) || [];
        files.push(file);
        missing.set(match[1], files);
      }
    }
  }
}
if (missing.size) {
  for (const [id, files] of missing) console.error(`#${id}: ${[...new Set(files)].join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(`DOM binding check passed (${staticIds.size} static IDs, ${dynamicIds.size} generated IDs).`);
}
