#!/usr/bin/env python3
"""Render the Mermaid documentation pages as self-contained interactive HTML.

Requirements:
  - pandoc
  - Playwright with Chromium
  - network access while building (Mermaid is fetched only at build time)

The generated pages contain pre-rendered SVG, Mermaid source, and dependency-free
pan/zoom controls. They do not require a network connection at view time.
"""

from __future__ import annotations

import argparse
import html
import re
import subprocess
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
PAGES = {
    "code-flow-diagrams": {
        "title": "PhaseFinder Code Flow Diagrams",
        "description": "Interactive module, state, loading, DJF pipeline, rendering, and session flow diagrams for PhaseFinder.",
    },
    "function-call-and-user-decision-graphs": {
        "title": "PhaseFinder Function Calls And User Decisions",
        "description": "Interactive function-call and user-decision diagrams for the PhaseFinder staged DJF application.",
    },
}

MERMAID_BLOCK = re.compile(
    r'<pre class="mermaid"><code>(.*?)</code></pre>',
    re.DOTALL,
)
HEADING_TWO = re.compile(r'<h2 id="([^"]+)">(.*?)</h2>', re.DOTALL)
TAG = re.compile(r"<[^>]+>")


PAGE_CSS = r"""
:root {
  color-scheme: light;
  --bg: #f5f7fb;
  --panel: #ffffff;
  --text: #172033;
  --muted: #647086;
  --border: #d8deea;
  --accent: #126d8d;
  --accent-strong: #064f6b;
  --accent-soft: #e7f5f8;
  --logo-blue: #072c67;
  --control-bg: #f8fafc;
  --shadow: 0 16px 42px rgba(31, 45, 72, 0.12);
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  color: var(--text);
  background: var(--bg);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.58;
}
body.diagram-fullscreen-open { overflow: hidden; }
a { color: var(--accent-strong); }
code {
  border-radius: 4px;
  background: #edf1f7;
  padding: 0.08em 0.36em;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.92em;
}
.doc-header {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 64px;
  padding: 11px 22px;
  border-bottom: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.96);
  backdrop-filter: blur(12px);
}
.doc-header-title {
  flex: 1;
  color: var(--logo-blue);
  font-size: 1.16rem;
  font-weight: 800;
}
.doc-header a {
  border: 1px solid var(--accent);
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  padding: 7px 12px;
  font-size: 0.82rem;
  font-weight: 750;
  text-decoration: none;
}
.doc-layout {
  display: grid;
  grid-template-columns: 250px minmax(0, 1fr);
  gap: 34px;
  width: min(1720px, 100%);
  margin: 0 auto;
  padding: 26px 24px 72px;
  align-items: start;
}
.doc-toc {
  position: sticky;
  top: 86px;
  max-height: calc(100vh - 110px);
  overflow-y: auto;
  padding-right: 8px;
  font-size: 0.83rem;
}
.doc-toc-label {
  margin: 0 0 8px;
  color: var(--muted);
  font-size: 0.7rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.doc-toc ul {
  margin: 0;
  padding: 0 0 0 14px;
  border-left: 2px solid var(--border);
  list-style: none;
}
.doc-toc li { margin: 3px 0; }
.doc-toc a {
  display: block;
  color: var(--muted);
  padding: 3px 0;
  text-decoration: none;
}
.doc-toc a:hover { color: var(--accent-strong); }
.doc-content { min-width: 0; }
.doc-content > h1 {
  margin: 0 0 12px;
  color: var(--logo-blue);
  font-size: clamp(1.55rem, 2.7vw, 2.15rem);
  line-height: 1.2;
}
.doc-content > h1 + p {
  border: 1px solid #c7e4ea;
  border-radius: 12px;
  background: var(--accent-soft);
  padding: 15px 18px;
}
.doc-content h2 {
  margin: 42px 0 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
  color: var(--logo-blue);
  font-size: 1.24rem;
  scroll-margin-top: 82px;
}
.doc-content p { margin: 0 0 12px; }
.doc-content ul, .doc-content ol { margin: 0 0 16px; padding-left: 24px; }
.doc-content li { margin-bottom: 5px; }
.diagram-card {
  position: relative;
  margin: 14px 0 28px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  box-shadow: 0 3px 12px rgba(31, 45, 72, 0.05);
}
.diagram-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 50px;
  padding: 8px 10px 8px 14px;
  border-bottom: 1px solid var(--border);
  background: #fbfcfe;
}
.diagram-help {
  flex: 1;
  min-width: 180px;
  color: var(--muted);
  font-size: 0.76rem;
}
.diagram-controls { display: flex; align-items: center; gap: 5px; }
.diagram-controls button {
  min-width: 34px;
  height: 32px;
  border: 1px solid #cbd4e1;
  border-radius: 7px;
  background: var(--control-bg);
  color: var(--text);
  padding: 0 9px;
  font: inherit;
  font-size: 0.78rem;
  font-weight: 750;
  cursor: pointer;
}
.diagram-controls button:hover { border-color: var(--accent); background: var(--accent-soft); }
.diagram-controls button:focus-visible, .diagram-viewport:focus-visible {
  outline: 3px solid rgba(18, 109, 141, 0.28);
  outline-offset: 1px;
}
.diagram-zoom {
  display: inline-block;
  min-width: 48px;
  color: var(--muted);
  font-size: 0.74rem;
  text-align: center;
}
.diagram-viewport {
  position: relative;
  height: clamp(440px, 66vh, 760px);
  overflow: hidden;
  background-color: #fff;
  background-image:
    linear-gradient(rgba(100, 112, 134, 0.07) 1px, transparent 1px),
    linear-gradient(90deg, rgba(100, 112, 134, 0.07) 1px, transparent 1px);
  background-size: 24px 24px;
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.diagram-viewport.is-dragging { cursor: grabbing; }
.diagram-canvas {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
  will-change: transform;
}
.diagram-canvas svg {
  display: block;
  max-width: none !important;
  height: auto;
  background: #fff;
}
.diagram-source { border-top: 1px solid var(--border); background: #fbfcfe; }
.diagram-source summary {
  padding: 9px 14px;
  color: var(--muted);
  font-size: 0.76rem;
  font-weight: 700;
  cursor: pointer;
}
.diagram-source pre {
  max-height: 340px;
  margin: 0;
  overflow: auto;
  border-top: 1px solid var(--border);
  background: #111827;
  color: #e5edf8;
  padding: 14px;
  font-size: 0.76rem;
  line-height: 1.5;
}
.diagram-source code { padding: 0; background: transparent; color: inherit; }
.diagram-card.is-fullscreen {
  position: fixed;
  inset: 10px;
  z-index: 100;
  display: flex;
  flex-direction: column;
  margin: 0;
  border-radius: 10px;
  box-shadow: var(--shadow);
}
.diagram-card.is-fullscreen .diagram-viewport { flex: 1; height: auto; min-height: 0; }
.diagram-card.is-fullscreen .diagram-source { display: none; }
.doc-footer {
  margin-top: 42px;
  border-top: 1px solid var(--border);
  padding-top: 14px;
  color: var(--muted);
  font-size: 0.8rem;
}
@media (max-width: 900px) {
  .doc-layout { grid-template-columns: minmax(0, 1fr); padding-inline: 14px; }
  .doc-toc { position: static; max-height: none; }
  .doc-toc ul { columns: 2; }
  .diagram-toolbar { align-items: flex-start; flex-wrap: wrap; }
  .diagram-help { flex-basis: 100%; }
  .diagram-viewport { height: min(68vh, 600px); }
}
@media (max-width: 560px) {
  .doc-header-title { font-size: 0.98rem; }
  .doc-toc ul { columns: 1; }
  .diagram-controls { width: 100%; overflow-x: auto; }
  .diagram-viewport { height: 520px; }
}
"""


VIEWER_JS = r"""
(() => {
  const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
  const cards = [...document.querySelectorAll('.diagram-card')];

  function initializeCard(card) {
    const viewport = card.querySelector('.diagram-viewport');
    const canvas = card.querySelector('.diagram-canvas');
    const svg = canvas.querySelector('svg');
    const zoomOutput = card.querySelector('.diagram-zoom');
    const fullscreenButton = card.querySelector('[data-action="fullscreen"]');
    if (!svg || !svg.viewBox || !svg.viewBox.baseVal) return;

    const viewBox = svg.viewBox.baseVal;
    const naturalWidth = Math.max(1, viewBox.width || Number(svg.getAttribute('width')) || 1000);
    const naturalHeight = Math.max(1, viewBox.height || Number(svg.getAttribute('height')) || 600);
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.style.width = `${naturalWidth}px`;
    svg.style.height = `${naturalHeight}px`;
    canvas.style.width = `${naturalWidth}px`;
    canvas.style.height = `${naturalHeight}px`;

    let scale = 1;
    let offsetX = 0;
    let offsetY = 0;
    let dragging = false;
    let pointerId = null;
    let lastX = 0;
    let lastY = 0;
    let userAdjusted = false;

    const apply = () => {
      canvas.style.transform = `translate3d(${offsetX}px, ${offsetY}px, 0) scale(${scale})`;
      zoomOutput.textContent = `${Math.round(scale * 100)}%`;
    };

    const containScale = () => {
      const padding = 28;
      const availableWidth = Math.max(1, viewport.clientWidth - 2 * padding);
      const availableHeight = Math.max(1, viewport.clientHeight - 2 * padding);
      return clamp(Math.min(availableWidth / naturalWidth, availableHeight / naturalHeight), 0.04, 2.5);
    };

    const fit = () => {
      scale = containScale();
      offsetX = (viewport.clientWidth - naturalWidth * scale) / 2;
      offsetY = (viewport.clientHeight - naturalHeight * scale) / 2;
      userAdjusted = false;
      apply();
    };

    const fitWidth = () => {
      const padding = 28;
      scale = clamp((viewport.clientWidth - 2 * padding) / naturalWidth, 0.04, 2.5);
      offsetX = (viewport.clientWidth - naturalWidth * scale) / 2;
      offsetY = padding;
      userAdjusted = false;
      apply();
    };

    const fitReadable = () => {
      const widthScale = clamp((viewport.clientWidth - 56) / naturalWidth, 0.04, 2.5);
      if (containScale() < 0.46 && widthScale > containScale() * 1.3) fitWidth();
      else fit();
    };

    const actualSize = () => {
      scale = 1;
      offsetX = (viewport.clientWidth - naturalWidth) / 2;
      offsetY = Math.max(20, (viewport.clientHeight - naturalHeight) / 2);
      userAdjusted = true;
      apply();
    };

    const zoomAt = (nextScale, clientX, clientY) => {
      const rect = viewport.getBoundingClientRect();
      const pointX = clientX - rect.left;
      const pointY = clientY - rect.top;
      const diagramX = (pointX - offsetX) / scale;
      const diagramY = (pointY - offsetY) / scale;
      scale = clamp(nextScale, 0.04, 6);
      offsetX = pointX - diagramX * scale;
      offsetY = pointY - diagramY * scale;
      userAdjusted = true;
      apply();
    };

    const zoomCenter = (factor) => {
      const rect = viewport.getBoundingClientRect();
      zoomAt(scale * factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
    };

    card.querySelector('.diagram-controls').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const action = button.dataset.action;
      if (action === 'zoom-in') zoomCenter(1.22);
      if (action === 'zoom-out') zoomCenter(1 / 1.22);
      if (action === 'fit') fit();
      if (action === 'fit-width') fitWidth();
      if (action === 'actual') actualSize();
      if (action === 'fullscreen') {
        const entering = !card.classList.contains('is-fullscreen');
        cards.forEach((other) => other.classList.remove('is-fullscreen'));
        card.classList.toggle('is-fullscreen', entering);
        document.body.classList.toggle('diagram-fullscreen-open', entering);
        fullscreenButton.textContent = entering ? 'Exit full screen' : 'Full screen';
        fullscreenButton.setAttribute('aria-pressed', String(entering));
        requestAnimationFrame(fitReadable);
      }
    });

    viewport.addEventListener('wheel', (event) => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0014);
      zoomAt(scale * factor, event.clientX, event.clientY);
    }, { passive: false });

    viewport.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      dragging = true;
      pointerId = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;
      viewport.classList.add('is-dragging');
      viewport.setPointerCapture(pointerId);
    });
    viewport.addEventListener('pointermove', (event) => {
      if (!dragging || event.pointerId !== pointerId) return;
      offsetX += event.clientX - lastX;
      offsetY += event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      userAdjusted = true;
      apply();
    });
    const endDrag = (event) => {
      if (!dragging || event.pointerId !== pointerId) return;
      dragging = false;
      viewport.classList.remove('is-dragging');
      if (viewport.hasPointerCapture(pointerId)) viewport.releasePointerCapture(pointerId);
      pointerId = null;
    };
    viewport.addEventListener('pointerup', endDrag);
    viewport.addEventListener('pointercancel', endDrag);
    viewport.addEventListener('dblclick', fit);

    viewport.addEventListener('keydown', (event) => {
      const panStep = event.shiftKey ? 80 : 34;
      if (event.key === '0') {
        event.preventDefault();
        fit();
        return;
      }
      if (event.key === '1') {
        event.preventDefault();
        actualSize();
        return;
      }
      if (event.key.toLowerCase() === 'w') {
        event.preventDefault();
        fitWidth();
        return;
      }
      if (event.key === '+' || event.key === '=') zoomCenter(1.22);
      else if (event.key === '-') zoomCenter(1 / 1.22);
      else if (event.key === 'ArrowLeft') offsetX += panStep;
      else if (event.key === 'ArrowRight') offsetX -= panStep;
      else if (event.key === 'ArrowUp') offsetY += panStep;
      else if (event.key === 'ArrowDown') offsetY -= panStep;
      else return;
      event.preventDefault();
      userAdjusted = true;
      apply();
    });

    const resizeObserver = new ResizeObserver(() => {
      if (!userAdjusted) fitReadable();
    });
    resizeObserver.observe(viewport);
    requestAnimationFrame(fitReadable);
  }

  cards.forEach(initializeCard);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const fullscreen = document.querySelector('.diagram-card.is-fullscreen');
    if (!fullscreen) return;
    fullscreen.querySelector('[data-action="fullscreen"]').click();
  });
})();
"""


def markdown_to_html(markdown_path: Path) -> str:
    process = subprocess.run(
        ["pandoc", "--from=gfm", "--to=html5", "--wrap=none", str(markdown_path)],
        cwd=ROOT,
        check=True,
        text=True,
        capture_output=True,
    )
    return process.stdout


def extract_diagrams(fragment: str) -> list[str]:
    return [html.unescape(match.group(1)) for match in MERMAID_BLOCK.finditer(fragment)]


def render_mermaid(diagrams: list[str]) -> list[str]:
    loader = """<!doctype html><html><body><script type="module">
      import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11.16.0/+esm';
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'loose',
        theme: 'base',
        deterministicIds: true,
        deterministicIDSeed: 'phasefinder-diagram-docs',
        themeVariables: {
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: '16px',
          primaryColor: '#e7f5f8',
          primaryTextColor: '#172033',
          primaryBorderColor: '#126d8d',
          lineColor: '#52627a',
          secondaryColor: '#eef2ff',
          tertiaryColor: '#f8fafc',
          clusterBkg: '#f8fafc',
          clusterBorder: '#b9c4d4',
          noteBkgColor: '#fff8db',
          noteBorderColor: '#d4a72c'
        },
        flowchart: { htmlLabels: true, curve: 'basis', nodeSpacing: 52, rankSpacing: 68 },
        sequence: { diagramMarginX: 40, diagramMarginY: 24, actorMargin: 60, messageMargin: 38 }
      });
      window.__mermaid = mermaid;
      window.__mermaidReady = true;
    </script></body></html>"""

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1600, "height": 1000})
        page.set_content(loader)
        page.wait_for_function("() => window.__mermaidReady === true", timeout=60_000)
        rendered = page.evaluate(
            """async (sources) => {
              const output = [];
              for (let index = 0; index < sources.length; index += 1) {
                await window.__mermaid.parse(sources[index]);
                const result = await window.__mermaid.render(`phasefinder-mmd-${index}`, sources[index]);
                output.push(result.svg);
              }
              return output;
            }""",
            diagrams,
        )
        browser.close()
    return rendered


def diagram_card(svg: str, source: str, index: int) -> str:
    escaped_source = html.escape(source)
    return f"""<figure class="diagram-card" data-diagram-index="{index}">
  <div class="diagram-toolbar">
    <span class="diagram-help">Drag to pan · wheel/trackpad to zoom · 0 fits all · W fits width</span>
    <div class="diagram-controls" role="group" aria-label="Diagram view controls">
      <button type="button" data-action="zoom-out" title="Zoom out" aria-label="Zoom out">−</button>
      <output class="diagram-zoom" aria-live="polite">100%</output>
      <button type="button" data-action="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
      <button type="button" data-action="fit">Fit all</button>
      <button type="button" data-action="fit-width">Fit width</button>
      <button type="button" data-action="actual">100%</button>
      <button type="button" data-action="fullscreen" aria-pressed="false">Full screen</button>
    </div>
  </div>
  <div class="diagram-viewport" tabindex="0" role="img" aria-label="Interactive Mermaid diagram {index + 1}">
    <div class="diagram-canvas">{svg}</div>
  </div>
  <details class="diagram-source">
    <summary>Mermaid source</summary>
    <pre><code>{escaped_source}</code></pre>
  </details>
</figure>"""


def page_template(slug: str, title: str, description: str, content: str) -> str:
    toc_items = []
    for identifier, label_html in HEADING_TWO.findall(content):
        label = html.unescape(TAG.sub("", label_html))
        toc_items.append(f'<li><a href="#{identifier}">{html.escape(label)}</a></li>')
    toc = "\n".join(toc_items)
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="{html.escape(description, quote=True)}" />
  <title>{html.escape(title)}</title>
  <style>{PAGE_CSS}</style>
</head>
<body>
  <header class="doc-header">
    <span class="doc-header-title">{html.escape(title)}</span>
    <a href="../index.html">Open PhaseFinder</a>
  </header>
  <div class="doc-layout">
    <aside class="doc-toc">
      <p class="doc-toc-label">On this page</p>
      <nav aria-label="Table of contents"><ul>{toc}</ul></nav>
    </aside>
    <main class="doc-content">
      {content}
      <p class="doc-footer">Generated from <code>docs/{slug}.md</code>. Mermaid SVG is pre-rendered; pan/zoom works offline with no external runtime scripts.</p>
    </main>
  </div>
  <script>{VIEWER_JS}</script>
</body>
</html>
"""


def build_page(slug: str, metadata: dict[str, str]) -> Path:
    markdown_path = DOCS / f"{slug}.md"
    fragment = markdown_to_html(markdown_path)
    diagrams = extract_diagrams(fragment)
    if not diagrams:
        raise RuntimeError(f"No Mermaid blocks found in {markdown_path}")
    rendered = render_mermaid(diagrams)
    card_index = 0

    def replace(_match: re.Match[str]) -> str:
        nonlocal card_index
        card = diagram_card(rendered[card_index], diagrams[card_index], card_index)
        card_index += 1
        return card

    content = MERMAID_BLOCK.sub(replace, fragment)
    output_path = DOCS / f"{slug}.html"
    output_path.write_text(
        page_template(slug, metadata["title"], metadata["description"], content),
        encoding="utf-8",
    )
    print(f"Rendered {len(diagrams):2d} diagrams → {output_path.relative_to(ROOT)}")
    return output_path


def verify_pages(paths: list[Path]) -> None:
    """Exercise offline rendering and every interactive viewer control."""

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for path in paths:
            page_errors: list[str] = []
            external_requests: list[str] = []
            page = browser.new_page(viewport={"width": 1600, "height": 1000})
            page.on("pageerror", lambda error: page_errors.append(str(error)))
            page.on(
                "request",
                lambda request: external_requests.append(request.url)
                if request.url.startswith(("http://", "https://"))
                else None,
            )
            page.goto(path.resolve().as_uri(), wait_until="load")
            page.evaluate("document.documentElement.style.scrollBehavior = 'auto'")
            cards = page.locator(".diagram-card")
            card_count = cards.count()
            if card_count == 0:
                raise RuntimeError(f"No interactive diagrams found in {path}")
            if page.locator(".diagram-canvas svg").count() != card_count:
                raise RuntimeError(f"One or more Mermaid SVGs are missing in {path}")
            valid_viewboxes = page.locator(".diagram-canvas svg").evaluate_all(
                "svgs => svgs.every(svg => svg.viewBox.baseVal.width > 0 && svg.viewBox.baseVal.height > 0)"
            )
            if not valid_viewboxes:
                raise RuntimeError(f"One or more Mermaid SVG viewBoxes are invalid in {path}")

            page.wait_for_timeout(150)
            canvas = cards.first.locator(".diagram-canvas")
            cards.first.locator('[data-action="actual"]').click()
            if cards.first.locator(".diagram-zoom").text_content() != "100%":
                raise RuntimeError(f"Actual-size control did not select 100% in {path}")
            cards.first.locator('[data-action="fit-width"]').click()
            cards.first.locator('[data-action="fit"]').click()
            initial_transform = canvas.evaluate("element => element.style.transform")
            cards.first.locator('[data-action="zoom-in"]').click()
            page.wait_for_timeout(50)
            zoomed_transform = canvas.evaluate("element => element.style.transform")
            if zoomed_transform == initial_transform:
                raise RuntimeError(f"Zoom control did not change the diagram transform in {path}")

            viewport = cards.first.locator(".diagram-viewport")
            viewport.evaluate("element => element.scrollIntoView({ block: 'center' })")
            page.wait_for_timeout(50)
            bounds = viewport.bounding_box()
            if not bounds:
                raise RuntimeError(f"Diagram viewport has no layout box in {path}")
            visible_left = max(1, bounds["x"] + 2)
            visible_right = min(1599, bounds["x"] + bounds["width"] - 2)
            visible_top = max(1, bounds["y"] + 2)
            visible_bottom = min(999, bounds["y"] + bounds["height"] - 2)
            if visible_right <= visible_left or visible_bottom <= visible_top:
                raise RuntimeError(f"Diagram viewport is outside the browser viewport in {path}: {bounds}")
            center_x = (visible_left + visible_right) / 2
            center_y = (visible_top + visible_bottom) / 2
            page.mouse.move(center_x, center_y)
            page.mouse.down()
            page.mouse.move(center_x + 90, center_y + 55, steps=4)
            page.mouse.up()
            panned_transform = canvas.evaluate("element => element.style.transform")
            if panned_transform == zoomed_transform:
                raise RuntimeError(
                    f"Pointer pan did not change the diagram transform in {path}; "
                    f"viewport={bounds}, zoomed={zoomed_transform!r}, errors={page_errors}"
                )

            fullscreen = cards.first.locator('[data-action="fullscreen"]')
            fullscreen.click()
            if not cards.first.evaluate("element => element.classList.contains('is-fullscreen')"):
                raise RuntimeError(f"Full-screen control did not activate in {path}")
            page.screenshot(path=f"/tmp/{path.stem}-fullscreen.png", full_page=False)
            page.keyboard.press("Escape")
            if cards.first.evaluate("element => element.classList.contains('is-fullscreen')"):
                raise RuntimeError(f"Escape did not exit full-screen mode in {path}")

            viewport.focus()
            page.keyboard.press("0")
            if not cards.first.locator(".diagram-zoom").text_content().endswith("%"):
                raise RuntimeError(f"Keyboard fit did not update zoom output in {path}")

            page.set_viewport_size({"width": 480, "height": 800})
            page.wait_for_timeout(100)
            viewport.focus()
            page.keyboard.press("0")
            mobile_ok = page.evaluate(
                """() => getComputedStyle(document.querySelector('.doc-toc')).position === 'static'
                  && document.documentElement.scrollWidth <= window.innerWidth + 1
                  && document.querySelector('.diagram-viewport').clientHeight >= 500
                  && (() => {
                    const viewport = document.querySelector('.diagram-viewport').getBoundingClientRect();
                    const canvas = document.querySelector('.diagram-canvas').getBoundingClientRect();
                    return Math.min(viewport.right, canvas.right) - Math.max(viewport.left, canvas.left) > 20
                      && Math.min(viewport.bottom, canvas.bottom) - Math.max(viewport.top, canvas.top) > 20;
                  })()"""
            )
            if not mobile_ok:
                raise RuntimeError(f"Responsive viewer layout failed in {path}")
            page.screenshot(path=f"/tmp/{path.stem}-mobile.png", full_page=False)

            if page_errors:
                raise RuntimeError(f"Page errors in {path}: {page_errors}")
            if external_requests:
                raise RuntimeError(
                    f"Generated page is not offline/self-contained; external requests: {external_requests}"
                )
            print(f"Verified {card_count:2d} interactive diagrams → {path.relative_to(ROOT)}")
            page.close()
        browser.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("slugs", nargs="*", choices=sorted(PAGES), help="page(s) to build; defaults to both")
    parser.add_argument("--verify", action="store_true", help="verify interaction and responsive behavior after building")
    parser.add_argument("--verify-only", action="store_true", help="verify existing HTML without rebuilding")
    arguments = parser.parse_args()
    slugs = arguments.slugs or list(PAGES)
    if arguments.verify_only:
        paths = [DOCS / f"{slug}.html" for slug in slugs]
    else:
        paths = [build_page(slug, PAGES[slug]) for slug in slugs]
    if arguments.verify or arguments.verify_only:
        verify_pages(paths)


if __name__ == "__main__":
    main()
