#!/usr/bin/env python3
"""Validate public documentation links, HTML, manifest, TOML, and UI labels."""

import html
import json
import re
import tomllib
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}
errors = []


class DocumentParser(HTMLParser):
    def __init__(self, path):
        super().__init__(convert_charrefs=True)
        self.path = path
        self.stack = []
        self.ids = set()
        self.references = []
        self.ui_labels = []
        self._label_depth = 0
        self._label_text = []
        self.has_lang = False
        self.has_title = False

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "html" and values.get("lang", "").strip():
            self.has_lang = True
        if tag == "title":
            self.has_title = True
        if values.get("id"):
            if values["id"] in self.ids:
                errors.append(f"{self.path}: duplicate id #{values['id']}")
            self.ids.add(values["id"])
        for name in ("href", "src"):
            if values.get(name):
                self.references.append(values[name])
        classes = values.get("class", "").split()
        if "ui_label" in classes:
            self._label_depth = len(self.stack) + 1
            self._label_text = []
        if tag not in VOID:
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if not self.stack or self.stack[-1] != tag:
            found = self.stack[-1] if self.stack else "nothing"
            errors.append(f"{self.path}: closing </{tag}> found after <{found}>")
            return
        if self._label_depth == len(self.stack):
            label = " ".join("".join(self._label_text).split())
            if label:
                self.ui_labels.append(label)
            self._label_depth = 0
            self._label_text = []
        self.stack.pop()

    def handle_data(self, data):
        if self._label_depth:
            self._label_text.append(data)

    def close(self):
        super().close()
        if self.stack:
            errors.append(f"{self.path}: unclosed tag <{self.stack[-1]}>")


html_paths = [ROOT / "index.html", *sorted((ROOT / "help").glob("*.html"))]
parsed = {}
for path in html_paths:
    parser = DocumentParser(path.relative_to(ROOT))
    parser.feed(path.read_text(encoding="utf-8"))
    parser.close()
    parsed[path.resolve()] = parser
    if not parser.has_lang:
        errors.append(f"{path.relative_to(ROOT)}: missing html lang")
    if not parser.has_title:
        errors.append(f"{path.relative_to(ROOT)}: missing title")


def check_target(source, raw):
    if not raw or raw.startswith(("#", "data:", "mailto:", "tel:", "javascript:")):
        return
    parts = urlsplit(raw)
    if parts.scheme or parts.netloc or "{{" in raw:
        return
    target = (ROOT / unquote(parts.path.lstrip("/"))) if parts.path.startswith("/") else (source.parent / unquote(parts.path))
    target = target.resolve()
    if not target.exists():
        errors.append(f"{source.relative_to(ROOT)}: missing local target {raw}")
        return
    if parts.fragment and target.suffix.lower() == ".html":
        parser = parsed.get(target)
        if parser is None:
            parser = DocumentParser(target.relative_to(ROOT))
            parser.feed(target.read_text(encoding="utf-8"))
            parser.close()
            parsed[target] = parser
        if unquote(parts.fragment) not in parser.ids:
            errors.append(f"{source.relative_to(ROOT)}: missing anchor {raw}")


for path in html_paths:
    for reference in parsed[path.resolve()].references:
        check_target(path, reference)

markdown_paths = [ROOT / "README.md", ROOT / "THIRD_PARTY_NOTICES.md", ROOT / "tests/e2e/README.md", *sorted((ROOT / "docs").glob("*.md"))]
markdown_link = re.compile(r"!?\[[^\]]*\]\(([^)\s]+)(?:\s+['\"][^)]*['\"])?\)")
for path in markdown_paths:
    if not path.exists():
        continue
    for target in markdown_link.findall(path.read_text(encoding="utf-8")):
        check_target(path, target.strip("<>"))

manifest_path = ROOT / "assets/img/favicon/site.webmanifest"
try:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for icon in manifest.get("icons", []):
        check_target(manifest_path, icon["src"])
        if not re.fullmatch(r"\d+x\d+", icon.get("sizes", "")):
            errors.append(f"{manifest_path.relative_to(ROOT)}: invalid icon sizes {icon.get('sizes')!r}")
except (KeyError, ValueError) as error:
    errors.append(f"{manifest_path.relative_to(ROOT)}: {error}")

for path in sorted((ROOT / "assets/misc").glob("*.toml")):
    try:
        tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as error:
        errors.append(f"{path.relative_to(ROOT)}: {error}")

source_corpus = html.unescape((ROOT / "index.html").read_text(encoding="utf-8"))
source_corpus += "\n".join(path.read_text(encoding="utf-8") for path in (ROOT / "js").rglob("*.js"))
for path in html_paths[1:]:
    for label in parsed[path.resolve()].ui_labels:
        needle = html.unescape(label).replace("(N)", "(").replace("…", "")
        if needle not in source_corpus and label not in {"Loaded FCS files (N)"}:
            errors.append(f"{path.relative_to(ROOT)}: documented UI label not found in app source: {label!r}")

if errors:
    raise SystemExit("\n".join(errors))
print(f"Document checks passed: {len(html_paths)} HTML pages, {len(markdown_paths)} Markdown files, manifest, TOML, and Help UI labels.")
