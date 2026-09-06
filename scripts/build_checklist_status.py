#!/usr/bin/env python3
"""Render the issue tracker from Markdown alone; --check fails on stale output."""
from __future__ import annotations
import argparse
import html
import re
from collections import Counter
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from pathlib import Path
from string import Template

ROOT = Path(__file__).resolve().parents[1]
CHECKLIST = ROOT / "docs/audits/master_checklist.md"
TEMPLATE = ROOT / "docs/audits/checklist_status_template.html"
OUTPUT = ROOT / "docs/audits/master_checklist_status.html"
ITEM_RE = re.compile(r"^### ([A-Z][A-Z0-9]*(?:-[A-Z]+)?-\d+) — (.+)$")
BOX_RE = re.compile(r"^\s*- \[([ xX~?])\]\s")
SUBHEAD_RE = re.compile(r"^#### (.*)$")
BODY_BOX_RE = re.compile(r"^\s*- \[([ xX~?])\]\s+(.*)$")
BULLET_RE = re.compile(r"^\s*- (.*)$")
NUM_RE = re.compile(r"^\s*\d+\.\s+(.*)$")
TABLE_ROW_RE = re.compile(r"^\s*\|(.+)\|\s*$")
TABLE_SEP_RE = re.compile(r"^[\s|:-]+$")
CHECKBOX_STATE = {"x": "done", " ": "open", "~": "partial", "?": "pending"}


def parse_checklist(text: str) -> list[dict]:
    items, seen = [], set()
    current, section, fence = None, "Other", None
    for line in text.splitlines():
        mark = re.match(r"^\s*(`{3,}|~{3,})", line)
        if mark:
            delimiter = mark[1]
            if fence is None:
                fence = delimiter
            elif delimiter[0] == fence[0] and len(delimiter) >= len(fence) and line.strip() == delimiter:
                fence = None
            if current is not None:
                current["body"].append(line)
            continue
        if fence:
            if current is not None:
                current["body"].append(line)
            continue
        match = ITEM_RE.match(line)
        if match:
            issue_id = match[1]
            if issue_id in seen:
                raise ValueError(f"Duplicate issue ID: {issue_id}")
            seen.add(issue_id)
            current = {"id": issue_id, "title": match[2], "section": section,
                       "body": [], "boxes": [], "fields": {}}
            items.append(current)
            continue
        if line.startswith("# Section "):
            section = line[2:]
        if re.match(r"^#{1,3} ", line) or line.strip() == "---":
            if line.startswith("### ") and re.match(r"### [A-Z][A-Z0-9]*(?:-[A-Z]+)?-\d+", line):
                raise ValueError(f"Malformed issue heading: {line}")
            current = None
            continue
        if current is None:
            continue
        current["body"].append(line)
        box = BOX_RE.match(line)
        if box:
            current["boxes"].append(box[1].lower())
        review_label = re.search(r"\*\*(Review \(\d{4}-\d{2}-\d{2}\)):\*\*", line)
        labels = ["Priority", "Status", "Started", "Completed", "Model", "Problem", "Recommendation"]
        if review_label:
            labels.append(review_label[1])
        for label in labels:
            match = re.search(r"\*\*" + re.escape(label) + r":\*\*\s*([^\n]*)", line)
            if match:
                if label in current["fields"]:
                    raise ValueError(f"Duplicate {label} field: {current['id']}")
                current["fields"][label] = match[1].split(" · ")[0].strip() if label in ("Priority", "Status") else match[1]
    if fence:
        raise ValueError("Unclosed Markdown fence")
    for item in items:
        fields, boxes = item["fields"], item["boxes"]
        priority = re.search(r"\bP[0-3]\b", fields.get("Priority", ""))
        if not priority or not boxes:
            raise ValueError(f"Missing priority or acceptance boxes: {item['id']}")
        item["priority"] = priority[0]
        item["ticked"], item["total"] = boxes.count("x"), len(boxes)
        derived = "closed" if all(b == "x" for b in boxes) else "partial" if any(b in ("x", "~") for b in boxes) else "open"
        explicit = re.search(r"\[([ x~?])\]", fields.get("Status", ""))
        if fields.get("Status") and not explicit:
            raise ValueError(f"Status must use a checkbox marker: {item['id']}")
        status = {"x": "closed", "~": "partial", " ": "open", "?": "open"}[explicit[1]] if explicit else derived
        if (status == "closed" and derived != "closed") or (status == "open" and derived != "open") or (status == "partial" and derived == "closed"):
            raise ValueError(f"Status conflicts with acceptance boxes: {item['id']}")
        item["status"] = status
        item["blocked"] = bool(re.search(r"\b(blocked|deferred)\b", fields.get("Status", ""), re.I))
    return items


def inline(text: str) -> str:
    """Escape, then honour `code`, [links](url), **bold**, and *italic*.

    Code spans and link targets are stashed behind a placeholder before the
    bold/italic passes run, so a literal `*` inside `` `0.45*score` `` isn't
    read as emphasis -- without this, code containing arithmetic reliably
    produces mismatched <em>/<code> nesting.
    """
    out = html.escape(text, quote=False)
    stash: list[str] = []

    def keep(fragment: str) -> str:
        stash.append(fragment)
        return f"\x00{len(stash) - 1}\x00"

    out = re.sub(r"`([^`]+)`", lambda m: keep(f"<code>{m.group(1)}</code>"), out)
    out = re.sub(
        r"\[([^\]]+)\]\(([^)\s]+)\)",
        lambda m: keep(f'<a href="{html.escape(m.group(2), quote=True)}">{m.group(1)}</a>'),
        out,
    )
    out = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", out)
    out = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", out)
    out = re.sub(r"\x00(\d+)\x00", lambda m: stash[int(m.group(1))], out)
    return out


def render_body(raw_lines: list[str]) -> str:
    """Render an item's markdown body to HTML: paragraphs, `#### ` sub-heads,
    checkbox/bullet/numbered lists (with plain continuation lines folded into
    the previous list item), fenced code blocks, block quotes, and pipe
    tables. Not a general CommonMark implementation -- just enough of the
    subset this document actually uses to look like the source."""
    lines = list(raw_lines)
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()

    out: list[str] = []
    para: list[str] = []
    list_tag: str | None = None
    list_items: list[str] = []

    def flush_para() -> None:
        if para:
            out.append(f"<p>{inline(' '.join(para))}</p>")
            para.clear()

    def flush_list() -> None:
        nonlocal list_tag
        if list_tag:
            out.append(f"<{list_tag}>" + "".join(list_items) + f"</{list_tag}>")
            list_items.clear()
            list_tag = None

    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        stripped = line.strip()

        sub = SUBHEAD_RE.match(line)
        if sub:
            flush_para()
            flush_list()
            out.append(f"<h4>{inline(sub.group(1))}</h4>")
            i += 1
            continue

        if re.match(r"^\s*(`{3,}|~{3,})", line):
            flush_para()
            flush_list()
            code: list[str] = []
            i += 1
            delimiter = re.match(r"^\s*(`{3,}|~{3,})", line)[1]
            closing = re.compile(r"^\s*" + re.escape(delimiter[0]) + "{" + str(len(delimiter)) + r",}\s*$")
            while i < n and not closing.match(lines[i]):
                code.append(lines[i])
                i += 1
            i += 1  # skip the closing fence
            out.append(f"<pre><code>{html.escape(chr(10).join(code))}</code></pre>")
            continue

        if not stripped:
            flush_para()
            flush_list()
            i += 1
            continue

        if stripped.startswith(">"):
            flush_para()
            flush_list()
            quote: list[str] = []
            while i < n and lines[i].strip().startswith(">"):
                quote.append(re.sub(r"^\s*>\s?", "", lines[i]))
                i += 1
            out.append(f"<blockquote><p>{inline(' '.join(quote))}</p></blockquote>")
            continue

        header = TABLE_ROW_RE.match(line)
        if header and i + 1 < n and TABLE_SEP_RE.match(lines[i + 1]) and "-" in lines[i + 1]:
            flush_para()
            flush_list()
            head_cells = [c.strip() for c in header.group(1).split("|")]
            i += 2
            body_rows = []
            while i < n and TABLE_ROW_RE.match(lines[i]):
                body_rows.append([c.strip() for c in TABLE_ROW_RE.match(lines[i]).group(1).split("|")])
                i += 1
            thead = "".join(f"<th>{inline(c)}</th>" for c in head_cells)
            trows = "".join(
                "<tr>" + "".join(f"<td>{inline(c)}</td>" for c in row) + "</tr>" for row in body_rows
            )
            out.append(f"<table><thead><tr>{thead}</tr></thead><tbody>{trows}</tbody></table>")
            continue

        box = BODY_BOX_RE.match(line)
        bullet = None if box else BULLET_RE.match(line)
        numbered = NUM_RE.match(line)

        if box or bullet:
            flush_para()
            if list_tag != "ul":
                flush_list()
                list_tag = "ul"
            if box:
                state = CHECKBOX_STATE[box.group(1).lower()]
                checked = " checked" if box.group(1).lower() == "x" else ""
                list_items.append(
                    f'<li class="cb {state}"><input type="checkbox" disabled{checked}/> '
                    f"{inline(box.group(2))}</li>"
                )
            else:
                list_items.append(f"<li>{inline(bullet.group(1))}</li>")
            i += 1
            continue

        if numbered:
            flush_para()
            if list_tag != "ol":
                flush_list()
                list_tag = "ol"
            list_items.append(f"<li>{inline(numbered.group(1))}</li>")
            i += 1
            continue

        if list_tag and list_items:
            # A plain line right after a list item, with no blank line and no
            # marker of its own, is that item's wrapped continuation -- fold
            # it back in rather than starting a stray paragraph.
            list_items[-1] = list_items[-1][: -len("</li>")] + " " + inline(stripped) + "</li>"
            i += 1
            continue

        para.append(stripped)
        i += 1

    flush_para()
    flush_list()
    return "\n".join(out)




def render_document(markdown: str, template: str) -> tuple[str, Counter]:
    items = parse_checklist(markdown)
    counts = Counter(item["status"] for item in items)
    def timestamp_key(item, field="Completed"):
        value = item["fields"].get(field)
        if not value or value == "-":
            return datetime.min.replace(tzinfo=timezone.utc)
        timestamp = datetime.fromisoformat(value)
        if len(value) > 10 and timestamp.tzinfo is None:
            raise ValueError(f"{field} timestamp needs a timezone: {item['id']}")
        return timestamp.replace(tzinfo=timezone.utc) if timestamp.tzinfo is None else timestamp

    def tracking_cell(item, field):
        value = item["fields"].get(field)
        missing = '<td class="tracking-missing">-</td>'
        if not value or value == "-":
            return missing
        if field == "Model":
            return f'<td>{html.escape(value)}</td>'
        if len(value) == 10:  # A historical date alone does not establish a completion time.
            return missing
        timestamp = timestamp_key(item, field).astimezone(ZoneInfo("America/New_York"))
        return f'<td><time datetime="{html.escape(value, quote=True)}">{timestamp.strftime("%m/%d/%y %I:%M %p")}</time></td>'

    def tracking_rows(entries, closed):
        rows = []
        for item in entries:
            completed_cell = tracking_cell(item, "Completed") if closed else '<td></td>'
            rows.append(f'<tr data-task-id="{item["id"]}">{tracking_cell(item, "Started")}'
                        f'{completed_cell}{tracking_cell(item, "Model")}'
                        f'<td><a href="#{item["id"]}">{item["id"]}</a></td>'
                        f'<td><a href="#{item["id"]}">{inline(item["title"])}</a></td></tr>')
        return "\n".join(rows) or '<tr><td colspan="5" class="tracking-missing">-</td></tr>'

    completed = sorted((i for i in items if i["status"] == "closed"), key=timestamp_key, reverse=True)
    active = sorted((i for i in items if i["status"] != "closed" and i["fields"].get("Started")),
                    key=lambda item: timestamp_key(item, "Started"), reverse=True)
    cards, section_options = [], []
    for section in dict.fromkeys(item["section"] for item in items):
        section_options.append(f'<option>{html.escape(section)}</option>')
        cards.append(f'<section class="issue-section" data-section="{html.escape(section, quote=True)}"><h2>{html.escape(section)}</h2>')
        for item in (i for i in items if i["section"] == section):
            fields = item["fields"]
            problem = fields.get("Problem", item["title"])
            review = next((fields[key] for key in sorted(fields, reverse=True) if key.startswith("Review (")), "No current review recorded.")
            recommendation = fields.get("Recommendation", "Complete the acceptance checklist below.")
            blocked = '<span class="badge">Blocked / deferred</span>' if item["blocked"] else ''
            cards.append(
                f'<article id="{item["id"]}" data-status="{item["status"]}" data-priority="{item["priority"]}">'
                f'<div class="badges"><a href="#{item["id"]}">{item["id"]}</a> '
                f'<span class="badge {item["priority"]}">{item["priority"]}</span> '
                f'<span class="badge {item["status"]}">{item["status"].capitalize()}</span>{blocked}'
                f'<span>{item["ticked"]}/{item["total"]} acceptance boxes complete</span></div>'
                f'<h3>{inline(item["title"])}</h3>'
                f'<div class="columns"><div><h4>Issue and evidence</h4><p>{inline(problem)}</p>'
                f'<p>{inline(review)}</p></div><div class="recommendation"><h4>Recommended next step</h4>'
                f'<p>{inline(recommendation)}</p></div></div>'
                '<details><summary>Full checklist text and historical evidence</summary>'
                f'<div class="details-body">{render_body(item["body"])}</div></details></article>'
            )
        cards.append('</section>')
    return Template(template).substitute(
        total=len(items), open=counts["open"], partial=counts["partial"], closed=counts["closed"],
        current_work=tracking_rows(active, False), completion_history=tracking_rows(completed, True), cards="\n".join(cards), section_options="\n".join(section_options),
    ), counts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    page, counts = render_document(CHECKLIST.read_text(), TEMPLATE.read_text())
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_text() != page:
            print("Tracker is stale: run python3 scripts/build_checklist_status.py")
            return 1
    else:
        OUTPUT.write_text(page)
    print(f"Tracker: {sum(counts.values())} total; {counts['open']} open; {counts['partial']} partial; {counts['closed']} closed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
