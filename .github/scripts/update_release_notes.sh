#!/usr/bin/env bash
set -euo pipefail

TAG="${1:?Usage: update_release_notes.sh <tag> [dry-run]}"
DRY_RUN="${2:-false}"

# Use GitHub Actions' value when available, otherwise use this default locally.
GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-Latent-Lens/PhaseFinder}"

REPO_URL="https://github.com/${GITHUB_REPOSITORY}"
SITE_URL="https://PhaseFinder.LatentLens.org"

# Fixed logo URL.
LOGO_URL="https://raw.githubusercontent.com/Latent-Lens/PhaseFinder/b0702067be55584d969eaf3449517ef4c40614f2/assets/img/logo.png"

# Determine the previous tag, if any.
PREV_TAG="$(git describe --tags --abbrev=0 "$TAG^" 2>/dev/null || true)"

# Temporary files.
TMP_FILE="$(mktemp --suffix=.md)"
CSS_FILE="$(mktemp --suffix=.css)"

trap 'rm -f "$TMP_FILE" "$CSS_FILE"' EXIT

{
  echo '<table width="100%" style="width: 100%; border-collapse: collapse; border: none; margin: 0; table-layout: fixed;">'
  echo '  <tr style="border: none;">'
  echo '    <td width="55%" style="border: none; vertical-align: middle; padding-right: 8px;">'
  echo "      <h1 style=\"white-space: nowrap; margin: 0 0 16px 0; padding: 0; border: none;\">PhaseFinder ${TAG}</h1>"
  echo '      <p>'
  echo '        PhaseFinder is a browser-based tool for inspecting and plotting'
  echo '        flow cytometry <code>.fcs</code> files. It is designed as a lightweight,'
  echo '        local-first application, where all data and analysis are performed on'
  echo "        the user's machine without uploading user data to any server."
  echo '      </p>'
  echo '      <p>'
  echo "        🔗 <strong>Access the site:</strong> <a href=\"${SITE_URL}\">${SITE_URL}</a>"
  echo '      </p>'
  echo '    </td>'
  echo '    <td align="right" width="45%" style="border: none; vertical-align: middle; padding-left: 0;">'
  echo "      <img src=\"${LOGO_URL}\" alt=\"PhaseFinder\" width=\"320\" />"
  echo '    </td>'
  echo '  </tr>'
  echo '</table>'
  echo ''
  echo '## Changes'
  echo ''

  if [[ -n "$PREV_TAG" ]]; then
    git log "$PREV_TAG..$TAG" \
      --pretty=format:"- [[%h](${REPO_URL}/commit/%H)] %s"
  else
    git log "$TAG" \
      --pretty=format:"- [[%h](${REPO_URL}/commit/%H)] %s"
  fi

  echo ''
} > "$TMP_FILE"

if [[ "$DRY_RUN" == "true" ]]; then
  HTML_FILE="release-notes-preview.html"

  echo "Dry run: generated release notes"
  echo "--------------------------------"
  cat "$TMP_FILE"

  cat > "$CSS_FILE" <<'EOF'
html,
body {
  width: 100%;
  max-width: none;
  margin: 0;
  padding: 0;
}

body {
  box-sizing: border-box;
  padding: 2rem;
}

main {
  width: 100%;
  max-width: none;
}

table,
thead,
tbody,
tr,
th,
td {
  border: none !important;
}

table {
  width: 100% !important;
  margin: 0 !important;
  border-collapse: collapse !important;
  table-layout: fixed !important;
}

h1 {
  border: none !important;
  padding: 0 !important;
}
EOF

  if command -v pandoc >/dev/null 2>&1; then
    pandoc "$TMP_FILE" \
      --from=markdown \
      --to=html5 \
      --standalone \
      --metadata pagetitle="PhaseFinder ${TAG}" \
      --css "$CSS_FILE" \
      --output "$HTML_FILE"
  else
    {
      echo '<!doctype html>'
      echo '<html lang="en">'
      echo '<head>'
      echo '  <meta charset="utf-8">'
      echo '  <meta name="viewport" content="width=device-width, initial-scale=1">'
      echo "  <title>PhaseFinder ${TAG}</title>"
      echo '  <style>'
      cat "$CSS_FILE"
      echo '  </style>'
      echo '</head>'
      echo '<body>'
      echo '<pre>'

      sed \
        -e 's/&/\&amp;/g' \
        -e 's/</\&lt;/g' \
        -e 's/>/\&gt;/g' \
        "$TMP_FILE"

      echo '</pre>'
      echo '</body>'
      echo '</html>'
    } > "$HTML_FILE"
  fi

  echo
  echo "HTML preview written to: $HTML_FILE"

  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo "## Release notes preview"
      echo
      cat "$TMP_FILE"
    } >> "$GITHUB_STEP_SUMMARY"
  fi
else
  gh release edit "$TAG" --notes-file "$TMP_FILE"
  echo "✅ Release notes updated for $TAG"
fi