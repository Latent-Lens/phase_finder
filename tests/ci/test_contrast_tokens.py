import re
import unittest
import colorsys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def luminance(color):
    channels = [int(color[index:index + 2], 16) / 255 for index in (1, 3, 5)]
    channels = [value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in channels]
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]


def contrast(foreground, background):
    light, dark = sorted((luminance(foreground), luminance(background)), reverse=True)
    return (light + 0.05) / (dark + 0.05)


class ContrastTokenTests(unittest.TestCase):
    def test_semantic_text_tokens_meet_wcag_aa_on_panel_background(self):
        for stylesheet in ("css/base.css", "css/help.css"):
            text = (ROOT / stylesheet).read_text()
            tokens = dict(re.findall(r"--([\w-]+):\s*(#[0-9a-fA-F]{6})", text))
            for name in ("text", "muted", "accent_strong", "teal_action", "success", "restart"):
                self.assertGreaterEqual(contrast(tokens[name], tokens["panel"]), 4.5, f"{stylesheet} --{name}")

    def test_brand_teal_is_not_used_as_small_text(self):
        offenders = []
        for path in (ROOT / "css").glob("*.css"):
            if re.search(r"^\s*color:\s*var\(--logo_teal\)", path.read_text(), re.MULTILINE):
                offenders.append(str(path.relative_to(ROOT)))
        self.assertEqual([], offenders)

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
