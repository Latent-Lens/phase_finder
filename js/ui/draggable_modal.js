// Generic drag-to-move for modal dialog cards. Originally a one-off on the
// axis-range modal (see plotting/axis_modal.js's git history); pulled out here
// so every .stats_modal_card in the app gets the same behavior from one call
// in main.js's bootstrap, instead of every modal wiring its own listeners.
//
// Mousedown anywhere on the card EXCEPT an interactive control (inputs,
// buttons, links, selects, textareas, labels) starts a drag -- "any white
// empty space", per the feature request, rather than a dedicated title-bar
// handle. make_modal_draggable() wires one card; clamp_to_viewport() is the
// shared bounds math, reused on every drag move and again on window resize so
// a card already dragged near an edge never ends up offscreen after the
// window shrinks.

const NON_DRAG_SELECTOR = "input, button, select, textarea, summary, a[href], label, [role='button'], [contenteditable='true']";

// Cards that have been dragged at least once (position: fixed with explicit
// left/top) -- these are the ones a resize can push offscreen; a still
// CSS-centered card tracks the viewport on its own.
const positioned_cards = new Set();

/*

Purpose:
	Clamps a fixed-position card's left/top so its full bounding box stays
	within the current viewport.

Input:
	card [HTMLElement]: a card with position: fixed and explicit left/top

Output:
	(none) [void]: rewrites the card's left/top inline styles if needed

*/
function clamp_to_viewport(card) {
  const rect = card.getBoundingClientRect();
  const max_x = Math.max(0, window.innerWidth - rect.width);
  const max_y = Math.max(0, window.innerHeight - rect.height);
  const left = Math.min(max_x, Math.max(0, rect.left));
  const top = Math.min(max_y, Math.max(0, rect.top));
  if (left !== rect.left) card.style.left = `${left}px`;
  if (top !== rect.top) card.style.top = `${top}px`;
}

window.addEventListener("resize", () => {
  positioned_cards.forEach((card) => {
    if (card.isConnected && !card.closest("[hidden]")) clamp_to_viewport(card);
  });
});

/*

Purpose:
	Makes one modal card draggable by mousedown-and-move on any non-interactive
	part of it, clamped so no edge ever leaves the viewport. Safe to call on a
	card more than once (a second call is a no-op).

Input:
	card [HTMLElement]: a .stats_modal_card (or similar) to make draggable

Output:
	(none) [void]: wires mousedown/mousemove/mouseup listeners

*/
export function make_modal_draggable(card) {
  if (!card || card.dataset.draggableModalWired) return;
  card.dataset.draggableModalWired = "1";

  let drag = null;

  card.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    if (event.target.closest(NON_DRAG_SELECTOR)) return;
    const rect = card.getBoundingClientRect();
    card.style.position = "fixed";
    card.style.margin = "0";
    card.style.left = `${rect.left}px`;
    card.style.top = `${rect.top}px`;
    positioned_cards.add(card);
    drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    card.setPointerCapture?.(event.pointerId);
    card.classList.add("stats_modal_card__dragging");
    event.preventDefault();
  });

  card.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const max_x = Math.max(0, window.innerWidth - card.offsetWidth);
    const max_y = Math.max(0, window.innerHeight - card.offsetHeight);
    card.style.left = `${Math.min(max_x, Math.max(0, event.clientX - drag.dx))}px`;
    card.style.top = `${Math.min(max_y, Math.max(0, event.clientY - drag.dy))}px`;
  });

  const end_drag = (event) => {
    if (!drag) return;
    drag = null;
    card.releasePointerCapture?.(event.pointerId);
    card.classList.remove("stats_modal_card__dragging");
  };
  card.addEventListener("pointerup", end_drag);
  card.addEventListener("pointercancel", end_drag);
}

export function reset_modal_position(card) {
  if (!card) return;
  positioned_cards.delete(card);
  for (const property of ["position", "margin", "left", "top"]) card.style.removeProperty(property);
}

// Every draggable modal card class. `.stats_modal_card` covers the dialog
// modals; `.progress_card` is the "Fitting…"/"Loading…" progress overlay, which
// is just as much a floating card and was reported as un-draggable because it
// was never in this list.
const DRAGGABLE_MODAL_SELECTOR = ".stats_modal_card, .progress_card";

/*

Purpose:
	Makes every draggable modal card currently in the document draggable. Called
	once from the entry bootstrap. The progress overlay's card lives in the DOM
	from load (only toggled hidden), so wiring it once here is enough.

Input:
	(none)

Output:
	(none) [void]

*/
export function init_draggable_modals() {
  document.querySelectorAll(DRAGGABLE_MODAL_SELECTOR).forEach((card) => {
    make_modal_draggable(card);
    const header = card.querySelector(".stats_modal_header");
    if (header && !header.querySelector(".stats_modal_position_reset")) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "stats_modal_position_reset";
      button.textContent = "Center";
      button.setAttribute("aria-label", "Reset dialog position to center");
      button.addEventListener("click", () => reset_modal_position(card));
      const close = header.querySelector(".stats_modal_close");
      if (close) close.before(button);
      else header.appendChild(button);
    }
  });
  const observer = new MutationObserver((records) => records.forEach(({ target }) => {
    const card = target.querySelector?.(".stats_modal_card");
    if (!target.hidden && card && positioned_cards.has(card)) clamp_to_viewport(card);
  }));
  document.querySelectorAll(".stats_modal").forEach((modal) => observer.observe(modal, { attributes: true, attributeFilter: ["hidden"] }));
}
