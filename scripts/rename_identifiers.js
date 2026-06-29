#!/usr/bin/env node
"use strict";

const fs = require("fs");
const acorn = require("acorn");
const walk = require("acorn-walk");

function usage() {
  console.error("Usage: node scripts/rename_identifiers.js '<json-map>' file.js [file2.js ...]");
  process.exit(2);
}

const [, , mapJson, ...files] = process.argv;
if (!mapJson || !files.length) usage();

const renameMap = JSON.parse(mapJson);

function addEdit(edits, start, end, text) {
  edits.push({ start, end, text });
}

function isPropertyKey(node, parent) {
  return parent && (
    (parent.type === "MemberExpression" && parent.property === node && !parent.computed) ||
    (parent.type === "Property" && parent.key === node && !parent.computed) ||
    (parent.type === "MethodDefinition" && parent.key === node && !parent.computed) ||
    (parent.type === "PropertyDefinition" && parent.key === node && !parent.computed)
  );
}

function isLabel(node, parent) {
  return parent && (
    (parent.type === "LabeledStatement" && parent.label === node) ||
    (parent.type === "BreakStatement" && parent.label === node) ||
    (parent.type === "ContinueStatement" && parent.label === node)
  );
}

function rewriteFile(file) {
  const source = fs.readFileSync(file, "utf8");
  const ast = acorn.parse(source, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowHashBang: true,
    locations: false,
  });

  const edits = [];
  const seenShorthand = new Set();

  walk.fullAncestor(ast, (node, ancestors) => {
    if (node.type === "Identifier") {
      const nextName = renameMap[node.name];
      if (!nextName) return;

      const parent = ancestors[ancestors.length - 2];
      if (!parent || isLabel(node, parent)) return;

      if (parent.type === "Property" && parent.shorthand && parent.value === node) {
        const key = `${parent.start}:${parent.end}`;
        if (!seenShorthand.has(key)) {
          seenShorthand.add(key);
          addEdit(edits, parent.start, parent.end, `${parent.key.name}: ${nextName}`);
        }
        return;
      }

      if (parent.type === "ObjectPattern") {
        const prop = parent.properties.find((candidate) =>
          candidate &&
          candidate.type === "Property" &&
          candidate.shorthand &&
          candidate.value &&
          candidate.value.start === node.start &&
          candidate.value.end === node.end
        );
        if (prop) {
          const key = `${prop.start}:${prop.end}`;
          if (!seenShorthand.has(key)) {
            seenShorthand.add(key);
            addEdit(edits, prop.start, prop.end, `${prop.key.name}: ${nextName}`);
          }
          return;
        }
      }

      if (isPropertyKey(node, parent)) return;

      addEdit(edits, node.start, node.end, nextName);
    }
  });

  if (!edits.length) return false;

  edits.sort((a, b) => b.start - a.start);
  let out = source;
  for (const edit of edits) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  fs.writeFileSync(file, out);
  return true;
}

for (const file of files) {
  if (rewriteFile(file)) {
    console.log(`rewrote ${file}`);
  }
}
