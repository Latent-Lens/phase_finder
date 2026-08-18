import re
import unittest
import colorsys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]

# UI-03: every surface a token can actually render text or a border on. Not
# every stylesheet defines every one of these (e.g. css/help.css has no
# --th_bg) -- callers filter to the surfaces present in the stylesheet under
# test rather than assuming this full set.
SURFACES = ("panel", "bg", "th_bg", "accent_soft")

# Tokens used as foreground *text* color somewhere in the app -- must clear
# WCAG 1.4.3's 4.5:1 minimum against every surface they can sit on. (--accent
# is deliberately excluded: it is only ever used for borders/backgrounds/
# hover glyphs in the current CSS, never body text -- --accent_strong is the
# token used where accent-colored text needs guaranteed AA contrast.)
TEXT_TOKENS = ("text", "muted", "accent_strong", "teal_action", "success", "restart")

# Tokens used as a *non-text* control boundary (border/outline) -- must clear
# WCAG 1.4.11's 3:1 minimum against every surface they can sit on.
BORDER_TOKENS = ("border", "dropzone_border", "progress_track_border")

# The token values before the UI-03 fix, kept here as a permanent regression
# guard: this file must always be able to demonstrate that these exact values
# fail the thresholds it enforces, so nobody can silently reintroduce them.
PRE_UI03_TOKENS = {
    "muted": "#647086",
    "border": "#d9dee8",
    "restart": "#dc2626",
    "dropzone_border": "#8ea0bd",
    "progress_track_border": "#b8c5d6",
}

# UI-04: the visual audit counted zero forced-colors blocks in these five
# stylesheets (base.css had 1, help.css had some, everything else had 0).
# Regression-guard that each now carries at least one.
FORCED_COLORS_EXPECTED_FILES = (
    "css/sidebar.css",
    "css/table.css",
    "css/layout.css",
    "css/plot.css",
    "css/feedback.css",
)

# UI-05: a bare `<selector>:focus { outline: none; }` (or `outline: 0`) with
# no matching `<selector>:focus-visible` rule restoring a real outline is a
# keyboard trap for sighted keyboard users -- the indicator is suppressed and
# never comes back. css/plot.css's `.peak_region_handle` was exactly this.
OUTLINE_SUPPRESSED_NO_REPLACEMENT = re.compile(
    r"([^\n{}]+?):focus\s*\{\s*outline:\s*(?:none|0)\s*;?\s*\}", re.MULTILINE)


def luminance(color):
    channels = [int(color[index:index + 2], 16) / 255 for index in (1, 3, 5)]
    channels = [value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in channels]
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]


def contrast(foreground, background):
    light, dark = sorted((luminance(foreground), luminance(background)), reverse=True)
    return (light + 0.05) / (dark + 0.05)


def read_tokens(stylesheet):
    text = (ROOT / stylesheet).read_text()
    return dict(re.findall(r"--([\w-]+):\s*(#[0-9a-fA-F]{6})", text))


class ContrastTokenTests(unittest.TestCase):
    def test_semantic_text_tokens_meet_wcag_aa_on_every_surface(self):
        """UI-03: text tokens must hit 4.5:1 on every surface they can sit
        on, not just --panel. Covers --bg, --th_bg and --accent_soft too."""
        for stylesheet in ("css/base.css", "css/help.css"):
            tokens = read_tokens(stylesheet)
            surfaces = [name for name in SURFACES if name in tokens]
            self.assertIn("panel", surfaces, f"{stylesheet} defines no --panel")
            for name in TEXT_TOKENS:
                if name not in tokens:
                    continue
                for surface in surfaces:
                    self.assertGreaterEqual(
                        contrast(tokens[name], tokens[surface]), 4.5,
                        f"{stylesheet} --{name} on --{surface}")

    def test_border_token_meets_nontext_contrast_on_every_surface(self):
        """UI-03: --border (css/base.css:13 pre-fix) was 1.35:1 against
        white, far under WCAG 1.4.11's 3:1 non-text minimum for control
        boundaries. Assert the fixed token clears 3:1 on every surface."""
        for stylesheet in ("css/base.css", "css/help.css"):
            tokens = read_tokens(stylesheet)
            surfaces = [name for name in SURFACES if name in tokens]
            for surface in surfaces:
                self.assertGreaterEqual(
                    contrast(tokens["border"], tokens[surface]), 3.0,
                    f"{stylesheet} --border on --{surface}")

    def test_component_boundary_tokens_meet_nontext_contrast_on_every_surface(self):
        """UI-03: 'component boundaries' beyond the shared --border token --
        --dropzone_border (the first-run drop target) and
        --progress_track_border -- must also clear the 3:1 non-text minimum."""
        tokens = read_tokens("css/base.css")
        surfaces = [name for name in SURFACES if name in tokens]
        for name in BORDER_TOKENS:
            if name not in tokens:
                continue
            for surface in surfaces:
                self.assertGreaterEqual(
                    contrast(tokens[name], tokens[surface]), 3.0,
                    f"css/base.css --{name} on --{surface}")

    def test_pre_ui03_tokens_would_have_failed(self):
        """Regression guard, not a live-token check: proves the thresholds
        above actually discriminate by replaying them against the exact
        hex values UI-03 replaced. --muted and --restart must fail the 4.5:1
        text minimum on their tightest surface (--accent_soft); --border,
        --dropzone_border and --progress_track_border must fail the 3:1
        non-text minimum on every surface. If this test ever passes, the
        contrast math above has been weakened, not the tokens improved."""
        tokens = read_tokens("css/base.css")
        accent_soft = tokens["accent_soft"]
        self.assertLess(contrast(PRE_UI03_TOKENS["muted"], accent_soft), 4.5)
        self.assertLess(contrast(PRE_UI03_TOKENS["restart"], tokens["th_bg"]), 4.5)
        for name in ("border", "dropzone_border", "progress_track_border"):
            for surface in SURFACES:
                if surface not in tokens:
                    continue
                self.assertLess(contrast(PRE_UI03_TOKENS[name], tokens[surface]), 3.0,
                                 f"pre-UI-03 --{name} on --{surface} unexpectedly passed")

    def test_brand_teal_is_not_used_as_small_text(self):
        offenders = []
        for path in (ROOT / "css").glob("*.css"):
            if re.search(r"^\s*color:\s*var\(--logo_teal\)", path.read_text(), re.MULTILINE):
                offenders.append(str(path.relative_to(ROOT)))
        self.assertEqual([], offenders)

    def test_forced_colors_blocks_cover_every_stylesheet(self):
        """UI-04: forced-colors support previously stopped at the shell --
        css/base.css (1 block) and css/help.css only; sidebar.css, table.css,
        layout.css and plot.css each had 0, and css/feedback.css (discovered
        during the same sweep) also had 0. Assert each now carries at least
        one @media (forced-colors: active) block, so the count can never
        silently regress back to 0."""
        for stylesheet in FORCED_COLORS_EXPECTED_FILES:
            text = (ROOT / stylesheet).read_text()
            self.assertIn("@media (forced-colors: active)", text, stylesheet)

    def test_gate_state_forced_colors_border_styles_stay_distinguishable(self):
        """UI-04: the AD-3 critical case. All six GATE_STATES values must
        remain visually distinguishable from one another once forced-colors
        flattens background/border-color to system colours -- otherwise
        QC-02's fix silently regresses for those users. The normal-mode
        rules already split the six into a solid-border group (not-run,
        applied, failed, running) and a dashed-border group (needs-review,
        skipped), each disambiguated further by a ::after content glyph or
        text-decoration; assert the forced-colors block explicitly restates
        that solid/dashed split so it cannot silently drift from the
        author border-color it depends on."""
        text = (ROOT / "css/plot.css").read_text()
        forced_colors_block = text.split("@media (forced-colors: active)", 1)[1]
        solid_states = ("not-run", "applied", "failed", "running")
        dashed_states = ("needs-review", "skipped")
        for state in solid_states + dashed_states:
            self.assertIn(f'data-gate-state="{state}"', forced_colors_block,
                           f"forced-colors block does not restate gate state {state!r}")
        self.assertIn("border-style: solid", forced_colors_block)
        self.assertIn("border-style: dashed", forced_colors_block)

    def test_feedback_css_has_focus_visible_treatment(self):
        """UI-05: css/feedback.css previously had zero :focus-visible rules
        (the status bar footer and every modal it owns relied entirely on
        base.css's global rule, which the footer's own `overflow: hidden`
        then clipped). Assert the file now defines its own."""
        text = (ROOT / "css/feedback.css").read_text()
        self.assertIn(":focus-visible", text)

    def test_no_outline_suppressed_without_focus_visible_replacement(self):
        """UI-05: sweep every stylesheet for `<selector>:focus { outline:
        none/0; }` and assert a matching `<selector>:focus-visible` rule
        restoring a real outline exists somewhere in the same file.
        css/plot.css's `.peak_region_handle` was exactly this: outline
        suppressed unconditionally, with only a JS-driven line-thickness
        change (not an outline) as the sole replacement."""
        offenders = []
        for css_file in sorted((ROOT / "css").glob("*.css")):
            text = css_file.read_text()
            for match in OUTLINE_SUPPRESSED_NO_REPLACEMENT.finditer(text):
                selector = match.group(1).strip()
                if f"{selector}:focus-visible" not in text:
                    offenders.append(f"{css_file.relative_to(ROOT)} {selector}")
        self.assertEqual([], offenders)

    def test_file_table_checkbox_meets_wcag22_target_size(self):
        """UI-11: row-selection checkboxes were 17x17px, under WCAG 2.2 SC
        2.5.8's 24px minimum target size. Assert the fixed rule clears it."""
        text = (ROOT / "css/table.css").read_text()
        match = re.search(r'\.file_table input\[type="checkbox"\]\s*\{([^}]*)\}', text)
        self.assertIsNotNone(match, "no .file_table input[type=\"checkbox\"] rule found")
        body = match.group(1)
        width = re.search(r"width:\s*(\d+)px", body)
        height = re.search(r"height:\s*(\d+)px", body)
        self.assertIsNotNone(width)
        self.assertIsNotNone(height)
        self.assertGreaterEqual(int(width.group(1)), 24)
        self.assertGreaterEqual(int(height.group(1)), 24)

    def test_pre_ui11_checkbox_size_would_have_failed(self):
        """Regression guard: the pre-fix 17px value must fail the 24px
        minimum the test above enforces, so the threshold itself is proven
        to discriminate."""
        self.assertLess(17, 24)

    def test_generated_chart_lines_and_component_outlines_meet_nontext_contrast(self):
        source = (ROOT / "js/plotting/data.js").read_text()
        self.assertIn("70%, 34%", source)
        for hue in range(360):
            red, green, blue = colorsys.hls_to_rgb(hue / 360, 0.34, 0.70)
            color = "#" + "".join(f"{round(channel * 255):02x}" for channel in (red, green, blue))
            self.assertGreaterEqual(contrast(color, "#ffffff"), 3.0, f"generated chart hue {hue}")
        render = (ROOT / "js/plotting/render.js").read_text()
        self.assertGreaterEqual(render.count('.attr("stroke", AXIS_LABEL_COLOR)'), 2)


if __name__ == "__main__":
    unittest.main()
