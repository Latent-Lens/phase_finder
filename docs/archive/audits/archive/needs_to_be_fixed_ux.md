> Archived 2026-09-05 from docs/audits/archive/needs_to_be_fixed_ux.md. Historical findings are reconciled in the master checklist; unchecked boxes here are not an active work queue. [Current register](../../../audits/master_checklist.md).

# PhaseFinder UX issues that still need to be fixed

Last reviewed: 2026-07-17
Review basis: current working tree, current E2E screenshots, and a live Chromium check at 390 x 844.
Guidance used: `/home/mike/.claude/agents/design-ux-architect.md`.

This is a current-open-issues list, not a history. Resolved findings are intentionally omitted. The previous copy of this document was not present in the repository or its parent directory at review time, so no reliable item-by-item removal log could be retained.

## Priority summary

| Priority | Count | Meaning |
| --- | ---: | --- |
| Critical | 1 | Breaks or hijacks a primary first-run journey |
| High | 4 | Blocks a viewport/input mode or creates a major accessibility failure |
| Medium | 3 | Makes important functionality difficult to discover or operate |
| Low | 1 | Design-system and user-preference gap |

## Critical

### UX-01 — A committed developer session hijacks every fresh launch

**Evidence**

- `sessions/phasefinder_local.json` and its referenced `sessions/phasefinder_session_20260705.toml` are tracked by Git.
- `js/session/core.js:349-388` fetches that local config on every startup, even though its own comment says the file is personal/local and “never committed.”
- `.github/workflows/deploy-release.yml` deploys the repository root, so the local config is included in a release unless separately excluded.
- A fresh browser load immediately opened “Reconnect Session Files” for six unavailable files instead of showing the empty first-run state.

**User impact**

New users are dropped into an unexplained recovery workflow for another person's experiment. The primary “load my FCS files” journey is obscured, and “Continue: skipping 6 missing files” makes the product appear broken or unsafe.

**Fix direction**

- Stop tracking the live `phasefinder_local.json` and experiment session; retain only an inert example.
- Add the live local-config filename to `.gitignore` and explicitly exclude local/session fixtures from the release payload.
- If autoload is a supported product feature, make it opt-in and visibly identify the session before attempting recovery.

**Acceptance check:** a clean/incognito launch of the deployed app always opens the empty “No files loaded” state unless that same user explicitly opted into an autoload session.

## High

### UX-02 — The mobile layout extends below the viewport and behind the fixed footer

**Evidence**

- `css/base.css:62-65` prevents body scrolling.
- At the mobile breakpoint, `css/responsive.css:22-25` stacks the header but does not replace the desktop `.app` height calculation, which assumes a 60 px header.
- At 390 x 844, the rendered header pushed `.app` down to y=154, while `.app` remained 744 px tall and ended at y=898. The fixed footer began at y=808. Content and the reconnect modal were therefore clipped/overlapped.

**User impact**

Phone and narrow-window users cannot reliably reach the bottom of the workspace or modal actions. This affects both ordinary reflow and the session-reconnect recovery path.

**Fix direction**

Use a page grid/flex shell with real header/main/footer rows instead of subtracting hard-coded heights. On narrow screens, allow document or main-region scrolling, keep the footer in normal layout (or reserve its exact space), and constrain modal cards within the unobscured viewport.

**Acceptance check:** at 320, 390, 768, and 820 px widths, all content and modal actions are reachable at 200% zoom, with no footer overlap or two-dimensional page scrolling.

### UX-03 — The primary upload target and logo reload shortcut are pointer-only

**Evidence**

- `index.html:87-92` implements the main upload target as a plain `<div>` with no keyboard role or tab stop; `js/main.js:219-239` only wires click and drag events.
- `index.html:37` implements the reload shortcut as an `<img>`; `js/main.js:241` only wires a click handler.
- The collapsed upload control is correctly a `<button>`, which highlights the inconsistency.

**User impact**

Keyboard and switch-device users cannot activate the prominent upload surface or the logo shortcut. The main task is visually advertised as clickable but absent from the tab order.

**Fix direction**

Make the upload surface a real button/label associated with the file input, preserving drag-and-drop enhancement. Treat the logo as non-interactive branding or wrap the reload action in a properly named button with Enter/Space behavior and a visible focus state.

**Acceptance check:** the entire initial file-load journey can be completed with Tab, Shift+Tab, Enter, and Space alone.

### UX-04 — Modal dialogs do not contain focus or return it to their trigger

**Evidence**

- The statistics and metadata dialogs move focus on open (`js/analysis/stats.js:172-195`, `js/ui/metadata_wizard.js:299-311`) but close by hiding the dialog without restoring focus.
- The reconnect dialog does not set initial focus at all (`js/session/reconnect.js:247-261`).
- No shared dialog code traps Tab/Shift+Tab, makes the background inert, or remembers the invoking control.

**User impact**

Keyboard and screen-reader users can tab into obscured page controls, lose their place after closing, or begin interacting behind a modal. The reconnect dialog is especially problematic because it can currently appear automatically.

**Fix direction**

Create one dialog controller used by every modal: save the opener, set a meaningful initial focus target, contain Tab navigation, mark the background inert, support Escape, and restore focus on every close path.

**Acceptance check:** automated keyboard tests cover open, forward/backward wrap, Escape, backdrop/cancel/confirm close, and focus restoration for every modal.

### UX-05 — Status and error updates are not reliably announced

**Evidence**

- The sidebar status at `index.html:100` and footer message at `index.html:488-490` have no live-region semantics.
- Only the progress overlay (`index.html:475-485`) is a live status region.
- The footer visually truncates long messages with an ellipsis, so important details can be unavailable visually as well as silent to assistive technology.

**User impact**

Loading completion, import errors, reconnect failures, and state changes can occur without a screen-reader announcement. Long errors such as metadata import failures may be partially hidden.

**Fix direction**

Use a single deliberate announcement channel: `role="status"`/`aria-live="polite"` for routine updates and `role="alert"` or assertive announcements for actionable failures. Provide a way to reveal/copy the full error rather than relying only on an ellipsized footer.

**Acceptance check:** screen-reader-oriented tests verify one non-duplicated announcement for success, progress completion, warning, and error cases.

## Medium

### UX-06 — Important plot actions are hidden behind undocumented double-click gestures

**Evidence**

- Axis range editing is only opened by double-clicking invisible SVG hit areas (`js/plotting/render.js:382-415`). Those groups have no role, name, tab stop, or keyboard handler.
- Curve/group isolation similarly relies on double-clicking a curve or tiny table color swatch; the help page does not document either gesture.

**User impact**

Users are unlikely to discover these controls, and keyboard/touch users cannot operate them consistently. An invisible double-click target is especially fragile in a scientific tool where precise ranges affect interpretation.

**Fix direction**

Add explicit “Axis ranges” and “Focus/isolate series” controls with visible current state and reset actions. Keep direct plot gestures only as shortcuts, and give any retained SVG interaction semantic button behavior plus keyboard support.

**Acceptance check:** both tasks are discoverable from visible controls and usable without a mouse or double-click.

### UX-07 — Both panel resizers are mouse-only and semantically hidden

**Evidence**

- `index.html:207` marks the sidebar resizer `aria-hidden="true"`; the workspace resizer follows the same non-interactive `<div>` pattern.
- `js/ui/panel_resize.js:28-62` and `:106-149` only handle `mousedown`, `mousemove`, and `mouseup`.
- Help explicitly advertises resizing as part of the interface (`help.html:318-319`).

**User impact**

Keyboard, touch, and assistive-technology users cannot perform a documented layout operation. There is also no precise or easily resettable size control.

**Fix direction**

Use focusable separators (`role="separator"`, orientation, value attributes) with arrow-key increments, Home/End or reset behavior, and pointer events. Provide a simple reset-to-default layout command.

**Acceptance check:** sidebar width and plot/table height can be adjusted and reset with keyboard, pointer, and touch input.

### UX-08 — Two adjacent “Run All” actions create avoidable modeling ambiguity

**Evidence**

- The modeling sidebar presents “Run All” under Pre-modeling QC Filtering and another “Run all” under the manual DJF pipeline (`index.html:124-145`).
- Current screenshots show the two equally prominent actions in the same narrow sidebar, with stages 1–4 above stages 5–8 and limited persistent explanation of what completed, what changed the data, or what will run next.

**User impact**

Users can choose the wrong bulk action or misunderstand whether QC gates are merely previewed, applied, or included in the DJF run. That uncertainty undermines confidence in analysis results.

**Fix direction**

Rename them to outcome-specific labels such as “Apply all QC gates” and “Run remaining DJF stages.” Add persistent per-stage states (not run/running/applied/failed/stale), a concise explanation of data impact, and a clear recommended path while preserving manual expert control.

**Acceptance check:** a first-time user can identify the recommended full workflow and explain which filters/stages affected the displayed result without relying on hover tooltips.

## Low

### UX-09 — The design system is light-only and ignores system/user theme preference

**Evidence**

- `css/base.css:5-52` declares only light tokens and forces `color-scheme: light`.
- There is no theme control, stored theme preference, or `prefers-color-scheme` handling anywhere in the app.

**User impact**

Users working in low-light environments cannot select a dark presentation, and the app does not respect an OS-level preference. This also falls short of the loaded UX architect guidance's default light/dark/system requirement.

**Fix direction**

Add semantic dark tokens and an always-available Light/Dark/System control. Persist explicit choice, follow live system changes in System mode, and validate plot/grid/status colors and focus indicators to WCAG 2.2 AA in every theme.

**Acceptance check:** the three theme modes work before and after file loading, survive reload where appropriate, and keep all plot series, states, and controls legible.

## Recommended implementation order

1. Remove the release autoload/session leak (UX-01).
2. Repair the responsive shell and modal viewport behavior (UX-02).
3. Establish shared accessible interaction foundations: upload semantics, dialog controller, and announcements (UX-03 through UX-05).
4. Replace hidden/mouse-only expert interactions with explicit, keyboard-operable controls (UX-06 and UX-07).
5. Clarify the modeling workflow, then add the complete theme token layer (UX-08 and UX-09).
