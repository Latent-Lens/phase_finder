// Minimal, dependency-free SVG -> single-page vector PDF converter, written for
// the specific SVG this app draws (plotting/render.js): groups with translate/
// rotate transforms, paths, rects, lines, circles and text, a single rectangular
// clipPath, and solid RGB paint with opacity. It is deliberately NOT a general
// SVG renderer -- gradients, images, filters, markers, patterns, dash phases and
// non-rectangular clips are ignored rather than approximated.
//
// Why hand-rolled: the plot's "download as PDF" option has to stay vector (the
// whole point of offering it next to PNG), and pulling in a full SVG-to-PDF
// library for one dialog would outweigh the app's entire dependency footprint.
//
// Paint is read from getComputedStyle rather than attributes so CSS-styled
// elements and d3-axis's "currentColor" resolve the same way they do on screen.

// Helvetica (PDF base-14) advance widths in 1/1000 em, ASCII 32-126. Used to
// place text-anchor: middle/end runs, which PDF has no concept of.
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const DEFAULT_GLYPH_WIDTH = 556;

// Bezier arc constant, for the rounded corners of a rect with rx/ry.
const KAPPA = 0.5522847498;

// ── Small matrix helpers ([a, b, c, d, e, f], row-vector convention) ─────────
const IDENTITY = [1, 0, 0, 1, 0, 0];

function multiply(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

// Average scale factor of a matrix, used to convert stroke widths (PDF strokes
// in user space, so a scaled group needs its line width scaled too).
function matrix_scale(m) {
  return (Math.hypot(m[0], m[1]) + Math.hypot(m[2], m[3])) / 2 || 1;
}

// SVG transform attribute -> matrix. Handles the forms d3 and this app emit.
function parse_transform(value) {
  if (!value || value === "none") return IDENTITY;
  let matrix = IDENTITY;
  const pattern = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let found;
  while ((found = pattern.exec(value)) !== null) {
    const name = found[1];
    const args = found[2].split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));
    let step = IDENTITY;
    if (name === "matrix" && args.length === 6) {
      step = args;
    } else if (name === "translate") {
      step = [1, 0, 0, 1, args[0] || 0, args[1] || 0];
    } else if (name === "scale") {
      const sx = args[0] == null ? 1 : args[0];
      step = [sx, 0, 0, args[1] == null ? sx : args[1], 0, 0];
    } else if (name === "rotate") {
      const angle = ((args[0] || 0) * Math.PI) / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const rotation = [cos, sin, -sin, cos, 0, 0];
      if (args.length >= 3) {
        step = multiply(multiply([1, 0, 0, 1, -args[1], -args[2]], rotation), [1, 0, 0, 1, args[1], args[2]]);
      } else {
        step = rotation;
      }
    } else if (name === "skewX") {
      step = [1, 0, Math.tan(((args[0] || 0) * Math.PI) / 180), 1, 0, 0];
    } else if (name === "skewY") {
      step = [1, Math.tan(((args[0] || 0) * Math.PI) / 180), 0, 1, 0, 0];
    }
    matrix = multiply(step, matrix);
  }
  return matrix;
}

// ── Paint ───────────────────────────────────────────────────────────────────
// "rgb(r, g, b)" / "rgba(r, g, b, a)" / "none" -> { r, g, b, a } in 0..1, or
// null when nothing should be painted.
function parse_color(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text || text === "none" || text === "transparent") return null;
  const numbers = text.match(/-?\d*\.?\d+/g);
  if (!numbers || numbers.length < 3) return null;
  const alpha = numbers.length >= 4 ? Number(numbers[3]) : 1;
  if (!(alpha > 0)) return null;
  return {
    r: Math.min(1, Math.max(0, Number(numbers[0]) / 255)),
    g: Math.min(1, Math.max(0, Number(numbers[1]) / 255)),
    b: Math.min(1, Math.max(0, Number(numbers[2]) / 255)),
    a: Math.min(1, Math.max(0, alpha)),
  };
}

function format_number(value) {
  if (!Number.isFinite(value)) return "0";
  return (Math.round(value * 1000) / 1000).toString();
}

function color_operator(color, is_stroke) {
  return `${format_number(color.r)} ${format_number(color.g)} ${format_number(color.b)} ${is_stroke ? "RG" : "rg"}`;
}

// ── Path data ───────────────────────────────────────────────────────────────
/*

Purpose:
	Converts an SVG path "d" string into PDF path operators. Curves are emitted
	as cubic beziers (PDF's only curve), so quadratic and smooth shorthands are
	converted; elliptical arcs are not used by this app's plot and are skipped.

Input:
	d [string]: the SVG path data attribute

Output:
	ops [string]: newline-separated PDF path construction operators

*/
function path_to_pdf(d) {
  if (!d) return "";
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
  if (!tokens) return "";

  const out = [];
  let index = 0;
  let command = "";
  let x = 0;
  let y = 0;
  let start_x = 0;
  let start_y = 0;
  // Control point of the previous curve, for the S/T smooth shorthands.
  let last_control = null;

  const number = () => Number(tokens[index++]);
  const move_to = (nx, ny) => { out.push(`${format_number(nx)} ${format_number(ny)} m`); };
  const line_to = (nx, ny) => { out.push(`${format_number(nx)} ${format_number(ny)} l`); };
  const curve_to = (x1, y1, x2, y2, nx, ny) => {
    out.push([x1, y1, x2, y2, nx, ny].map(format_number).join(" ") + " c");
  };

  while (index < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[index])) {
      command = tokens[index++];
    } else if (command === "M") {
      command = "L";
    } else if (command === "m") {
      command = "l";
    }
    const relative = command === command.toLowerCase();
    const base_x = relative ? x : 0;
    const base_y = relative ? y : 0;

    switch (command.toUpperCase()) {
      case "M": {
        x = base_x + number();
        y = base_y + number();
        start_x = x;
        start_y = y;
        last_control = null;
        move_to(x, y);
        break;
      }
      case "L": {
        x = base_x + number();
        y = base_y + number();
        last_control = null;
        line_to(x, y);
        break;
      }
      case "H": {
        x = base_x + number();
        last_control = null;
        line_to(x, y);
        break;
      }
      case "V": {
        y = base_y + number();
        last_control = null;
        line_to(x, y);
        break;
      }
      case "C": {
        const x1 = base_x + number();
        const y1 = base_y + number();
        const x2 = base_x + number();
        const y2 = base_y + number();
        x = base_x + number();
        y = base_y + number();
        last_control = [x2, y2];
        curve_to(x1, y1, x2, y2, x, y);
        break;
      }
      case "S": {
        const reflected = last_control ? [2 * x - last_control[0], 2 * y - last_control[1]] : [x, y];
        const x2 = base_x + number();
        const y2 = base_y + number();
        x = base_x + number();
        y = base_y + number();
        last_control = [x2, y2];
        curve_to(reflected[0], reflected[1], x2, y2, x, y);
        break;
      }
      case "Q": {
        const qx = base_x + number();
        const qy = base_y + number();
        const nx = base_x + number();
        const ny = base_y + number();
        // Quadratic -> cubic: control points sit 2/3 of the way to the quad's.
        curve_to(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y),
          nx + (2 / 3) * (qx - nx), ny + (2 / 3) * (qy - ny), nx, ny);
        last_control = [qx, qy];
        x = nx;
        y = ny;
        break;
      }
      case "T": {
        const qx = last_control ? 2 * x - last_control[0] : x;
        const qy = last_control ? 2 * y - last_control[1] : y;
        const nx = base_x + number();
        const ny = base_y + number();
        curve_to(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y),
          nx + (2 / 3) * (qx - nx), ny + (2 / 3) * (qy - ny), nx, ny);
        last_control = [qx, qy];
        x = nx;
        y = ny;
        break;
      }
      case "Z": {
        out.push("h");
        x = start_x;
        y = start_y;
        last_control = null;
        break;
      }
      case "A": {
        // Not emitted by this app's plot; consume the 7 parameters and place a
        // straight segment so a stray arc degrades instead of corrupting state.
        number(); number(); number(); number(); number();
        x = base_x + number();
        y = base_y + number();
        last_control = null;
        line_to(x, y);
        break;
      }
      default:
        index += 1;
        break;
    }
  }
  return out.join("\n");
}

function rect_to_pdf(x, y, width, height, rx, ry) {
  if (!(width > 0) || !(height > 0)) return "";
  const cx = Math.min(rx || 0, width / 2);
  const cy = Math.min(ry || rx || 0, height / 2);
  if (!(cx > 0) || !(cy > 0)) {
    return `${[x, y, width, height].map(format_number).join(" ")} re`;
  }
  const ox = cx * KAPPA;
  const oy = cy * KAPPA;
  const right = x + width;
  const bottom = y + height;
  return [
    `${format_number(x + cx)} ${format_number(y)} m`,
    `${format_number(right - cx)} ${format_number(y)} l`,
    `${[right - cx + ox, y, right, y + cy - oy, right, y + cy].map(format_number).join(" ")} c`,
    `${format_number(right)} ${format_number(bottom - cy)} l`,
    `${[right, bottom - cy + oy, right - cx + ox, bottom, right - cx, bottom].map(format_number).join(" ")} c`,
    `${format_number(x + cx)} ${format_number(bottom)} l`,
    `${[x + cx - ox, bottom, x, bottom - cy + oy, x, bottom - cy].map(format_number).join(" ")} c`,
    `${format_number(x)} ${format_number(y + cy)} l`,
    `${[x, y + cy - oy, x + cx - ox, y, x + cx, y].map(format_number).join(" ")} c`,
    "h",
  ].join("\n");
}

// ── Text ────────────────────────────────────────────────────────────────────
function text_width(text, font_size) {
  let total = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    const width = code >= 32 && code <= 126 ? HELVETICA_WIDTHS[code - 32] : DEFAULT_GLYPH_WIDTH;
    total += width;
  }
  return (total / 1000) * font_size;
}

// PDF literal strings: escape the delimiters, drop anything WinAnsi can't hold.
function pdf_string(text) {
  let out = "";
  for (const character of text) {
    const code = character.codePointAt(0);
    if (character === "(" || character === ")" || character === "\\") out += `\\${character}`;
    else if (code < 32) out += " ";
    else if (code <= 255) out += character;
    else out += "?";
  }
  return out;
}

// "0.71em" / "3" / "-0.5ex" -> user units, relative to the font size.
function parse_length(value, font_size) {
  if (value == null || value === "") return 0;
  const text = String(value).trim();
  const number = parseFloat(text);
  if (!Number.isFinite(number)) return 0;
  if (text.endsWith("em")) return number * font_size;
  if (text.endsWith("ex")) return number * font_size * 0.5;
  return number;
}

// ── DOM walk ────────────────────────────────────────────────────────────────
// Collected ExtGState entries, one per distinct (fill alpha, stroke alpha)
// pair, since PDF expresses constant alpha through a graphics state resource.
class AlphaStates {
  constructor() {
    this.byKey = new Map();
  }

  name(fill_alpha, stroke_alpha) {
    const fill = Math.round(Math.min(1, Math.max(0, fill_alpha)) * 1000) / 1000;
    const stroke = Math.round(Math.min(1, Math.max(0, stroke_alpha)) * 1000) / 1000;
    if (fill === 1 && stroke === 1) return null;
    const key = `${fill}_${stroke}`;
    if (!this.byKey.has(key)) this.byKey.set(key, { name: `GS${this.byKey.size + 1}`, fill, stroke });
    return this.byKey.get(key).name;
  }

  resources() {
    if (!this.byKey.size) return "";
    const entries = [...this.byKey.values()]
      .map((state) => `/${state.name} <</Type /ExtGState /ca ${state.fill} /CA ${state.stroke}>>`)
      .join(" ");
    return `/ExtGState <<${entries}>>`;
  }
}

// A rectangular clip inherited from an ancestor's clip-path="url(#id)". Only
// the plot's own rectangular clips are supported; anything else is ignored.
function clip_rect_for(element, svg_root) {
  const style = window.getComputedStyle(element);
  const raw = element.getAttribute("clip-path") || style.clipPath;
  const match = raw && /url\(["']?#([^"')]+)["']?\)/.exec(raw);
  if (!match) return null;
  const clip = svg_root.querySelector(`#${CSS.escape(match[1])}`);
  const rect = clip && clip.querySelector("rect");
  if (!rect) return null;
  return {
    x: Number(rect.getAttribute("x")) || 0,
    y: Number(rect.getAttribute("y")) || 0,
    width: Number(rect.getAttribute("width")) || 0,
    height: Number(rect.getAttribute("height")) || 0,
  };
}

function is_hidden(element, style) {
  return style.display === "none"
    || style.visibility === "hidden"
    || Number(style.opacity) === 0
    || element.hasAttribute("hidden");
}

// Emit `q <clip> <transform> cm ... Q` around one element's drawing operators.
function wrap(matrix, clip, body) {
  if (!body) return "";
  const parts = ["q"];
  if (clip) {
    // The clip is expressed in the element's own coordinate space, so it has to
    // be set under the same transform the shape is drawn with.
    parts.push(`${matrix.map(format_number).join(" ")} cm`);
    parts.push(`${[clip.x, clip.y, clip.width, clip.height].map(format_number).join(" ")} re W n`);
    parts.push(body);
  } else {
    parts.push(`${matrix.map(format_number).join(" ")} cm`);
    parts.push(body);
  }
  parts.push("Q");
  return parts.join("\n");
}

// Fill/stroke operator selection for a shape, plus the alpha graphics state.
function paint_for(style, scale, alphas) {
  const group_opacity = Number(style.opacity);
  const opacity = Number.isFinite(group_opacity) ? group_opacity : 1;
  const fill = parse_color(style.fill);
  const stroke = parse_color(style.stroke);
  const stroke_width = parseFloat(style.strokeWidth);
  const has_stroke = Boolean(stroke) && Number.isFinite(stroke_width) && stroke_width > 0;
  if (!fill && !has_stroke) return null;

  const fill_alpha = (fill ? fill.a : 1) * (Number(style.fillOpacity) || 0) * opacity;
  const stroke_alpha = (stroke ? stroke.a : 1) * (Number(style.strokeOpacity) || 0) * opacity;
  const show_fill = Boolean(fill) && fill_alpha > 0.002;
  const show_stroke = has_stroke && stroke_alpha > 0.002;
  if (!show_fill && !show_stroke) return null;

  const prefix = [];
  const alpha_name = alphas.name(show_fill ? fill_alpha : 1, show_stroke ? stroke_alpha : 1);
  if (alpha_name) prefix.push(`/${alpha_name} gs`);
  if (show_fill) prefix.push(color_operator(fill, false));
  if (show_stroke) {
    prefix.push(color_operator(stroke, true));
    prefix.push(`${format_number(stroke_width * scale)} w`);
    const dash = style.strokeDasharray;
    if (dash && dash !== "none") {
      const values = dash.match(/-?\d*\.?\d+/g);
      if (values && values.length) prefix.push(`[${values.map((v) => format_number(Number(v) * scale)).join(" ")}] 0 d`);
    }
  }
  return {
    prefix: prefix.join("\n"),
    // Shape painting operator: fill, stroke, or both.
    operator: show_fill && show_stroke ? "B" : (show_fill ? "f" : "S"),
    show_fill,
    show_stroke,
    fill,
    fill_alpha,
  };
}

function walk(element, matrix, svg_root, alphas, out) {
  const style = window.getComputedStyle(element);
  if (is_hidden(element, style)) return;

  const tag = element.tagName.toLowerCase();
  if (tag === "defs" || tag === "clippath" || tag === "title" || tag === "desc" || tag === "style") return;

  const local = multiply(parse_transform(element.getAttribute("transform")), matrix);
  const clip = clip_rect_for(element, svg_root);
  const scale = matrix_scale(local);

  if (tag === "g" || tag === "svg" || tag === "a") {
    const children = [];
    for (const child of element.children) walk(child, local, svg_root, alphas, children);
    if (!children.length) return;
    // A group's clip applies to all of its children, so it is emitted once
    // around them (in the group's own space) rather than per child.
    if (clip) {
      out.push([
        "q",
        `${local.map(format_number).join(" ")} cm`,
        `${[clip.x, clip.y, clip.width, clip.height].map(format_number).join(" ")} re W n`,
        `${invert_or_identity(local).map(format_number).join(" ")} cm`,
        children.join("\n"),
        "Q",
      ].join("\n"));
    } else {
      out.push(children.join("\n"));
    }
    return;
  }

  if (tag === "text") {
    const paint = paint_for(style, scale, alphas);
    if (!paint || !paint.show_fill) return;
    const text = element.textContent.replace(/\s+/g, " ").trim();
    if (!text) return;
    const font_size = parseFloat(style.fontSize) || 10;
    const x = Number(element.getAttribute("x")) || 0;
    const y = Number(element.getAttribute("y")) || 0;
    const dx = parse_length(element.getAttribute("dx"), font_size);
    const dy = parse_length(element.getAttribute("dy"), font_size);
    const anchor = style.textAnchor || "start";
    const width = text_width(text, font_size);
    const shift = anchor === "middle" ? -width / 2 : (anchor === "end" ? -width : 0);
    const bold = Number(style.fontWeight) >= 600 || style.fontWeight === "bold";
    // The page CTM flips y (SVG grows downward), so the text matrix flips back
    // to keep glyphs upright.
    const body = [
      paint.prefix,
      "BT",
      `/${bold ? "F2" : "F1"} ${format_number(font_size)} Tf`,
      `1 0 0 -1 ${format_number(x + dx + shift)} ${format_number(y + dy)} Tm`,
      `(${pdf_string(text)}) Tj`,
      "ET",
    ].filter(Boolean).join("\n");
    out.push(wrap(local, clip, body));
    return;
  }

  let shape = "";
  if (tag === "path") {
    shape = path_to_pdf(element.getAttribute("d"));
  } else if (tag === "rect") {
    shape = rect_to_pdf(
      Number(element.getAttribute("x")) || 0,
      Number(element.getAttribute("y")) || 0,
      Number(element.getAttribute("width")) || 0,
      Number(element.getAttribute("height")) || 0,
      Number(element.getAttribute("rx")) || 0,
      Number(element.getAttribute("ry")) || 0,
    );
  } else if (tag === "line") {
    const x1 = Number(element.getAttribute("x1")) || 0;
    const y1 = Number(element.getAttribute("y1")) || 0;
    const x2 = Number(element.getAttribute("x2")) || 0;
    const y2 = Number(element.getAttribute("y2")) || 0;
    shape = `${format_number(x1)} ${format_number(y1)} m\n${format_number(x2)} ${format_number(y2)} l`;
  } else if (tag === "circle" || tag === "ellipse") {
    const cx = Number(element.getAttribute("cx")) || 0;
    const cy = Number(element.getAttribute("cy")) || 0;
    const rx = Number(element.getAttribute("r") || element.getAttribute("rx")) || 0;
    const ry = Number(element.getAttribute("r") || element.getAttribute("ry")) || 0;
    if (rx > 0 && ry > 0) {
      const ox = rx * KAPPA;
      const oy = ry * KAPPA;
      shape = [
        `${format_number(cx - rx)} ${format_number(cy)} m`,
        `${[cx - rx, cy - oy, cx - ox, cy - ry, cx, cy - ry].map(format_number).join(" ")} c`,
        `${[cx + ox, cy - ry, cx + rx, cy - oy, cx + rx, cy].map(format_number).join(" ")} c`,
        `${[cx + rx, cy + oy, cx + ox, cy + ry, cx, cy + ry].map(format_number).join(" ")} c`,
        `${[cx - ox, cy + ry, cx - rx, cy + oy, cx - rx, cy].map(format_number).join(" ")} c`,
        "h",
      ].join("\n");
    }
  } else if (tag === "polyline" || tag === "polygon") {
    const points = (element.getAttribute("points") || "").match(/-?\d*\.?\d+/g);
    if (points && points.length >= 4) {
      const parts = [];
      for (let index = 0; index + 1 < points.length; index += 2) {
        parts.push(`${format_number(Number(points[index]))} ${format_number(Number(points[index + 1]))} ${index === 0 ? "m" : "l"}`);
      }
      if (tag === "polygon") parts.push("h");
      shape = parts.join("\n");
    }
  }
  if (!shape) return;

  const paint = paint_for(style, scale, alphas);
  if (!paint) return;
  // An unclosed stroked path must not be filled; PDF's B would close it.
  const operator = tag === "line" || tag === "polyline"
    ? (paint.show_stroke ? "S" : "n")
    : paint.operator;
  out.push(wrap(local, clip, [paint.prefix, shape, operator].filter(Boolean).join("\n")));
}

// Inverse of an affine matrix, or identity when it is singular (which would
// mean a degenerate transform we cannot undo anyway).
function invert_or_identity(m) {
  const determinant = m[0] * m[3] - m[1] * m[2];
  if (!determinant) return IDENTITY;
  return [
    m[3] / determinant,
    -m[1] / determinant,
    -m[2] / determinant,
    m[0] / determinant,
    (m[2] * m[5] - m[3] * m[4]) / determinant,
    (m[1] * m[4] - m[0] * m[5]) / determinant,
  ];
}

/*

Purpose:
	Renders a live SVG element into a one-page PDF whose page is the SVG's own
	pixel size (1 px -> 1 pt), keeping every curve, axis and label as vector art
	rather than a raster snapshot.

Input:
	svg [SVGElement]: an SVG that is currently in the document (its computed
	                  styles are what get drawn)
	options [object]: optional { background: string|null } CSS color painted
	                  behind the plot; null/omitted leaves the page transparent

Output:
	blob [Blob]: an "application/pdf" blob ready to download

*/
export function svg_to_pdf_blob(svg, options = {}) {
  const width = Number(svg.getAttribute("width")) || svg.clientWidth || 0;
  const height = Number(svg.getAttribute("height")) || svg.clientHeight || 0;
  if (!(width > 0) || !(height > 0)) throw new Error("The plot has no drawable size.");

  const alphas = new AlphaStates();
  const body = [];
  for (const child of svg.children) walk(child, IDENTITY, svg, alphas, body);

  const background = parse_color(options.background);
  const content = [
    "q",
    // Flip to SVG's y-down space so every coordinate below is used verbatim.
    `1 0 0 -1 0 ${format_number(height)} cm`,
    background
      ? `${color_operator(background, false)}\n0 0 ${format_number(width)} ${format_number(height)} re\nf`
      : "",
    body.join("\n"),
    "Q",
  ].filter(Boolean).join("\n");

  const objects = [
    "<</Type /Catalog /Pages 2 0 R>>",
    "<</Type /Pages /Kids [3 0 R] /Count 1>>",
    `<</Type /Page /Parent 2 0 R /MediaBox [0 0 ${format_number(width)} ${format_number(height)}]`
      + ` /Resources <</Font <</F1 5 0 R /F2 6 0 R>> ${alphas.resources()}>> /Contents 4 0 R>>`,
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
    "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>",
    "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding>>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xref_offset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1} /Root 1 0 R>>\nstartxref\n${xref_offset}\n%%EOF\n`;

  // latin1 so the byte offsets recorded in the xref table stay correct.
  const bytes = new Uint8Array(pdf.length);
  for (let index = 0; index < pdf.length; index += 1) bytes[index] = pdf.charCodeAt(index) & 0xff;
  return new Blob([bytes], { type: "application/pdf" });
}
