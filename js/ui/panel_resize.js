// Drag-resize behavior for the sidebar and workspace panels. This module lets the
// user resize the sidebar horizontally through the sidebar/workspace divider
// while respecting minimum and viewport-bounded maximum widths. It also lets the
// plot and metadata panels share vertical space when both are visible and
// expanded. It watches panel hidden/collapsed state so resizing handles are only
// active when the layout can actually change. After each resize, it dispatches
// resize events so the plot can redraw against the new dimensions. The entry
// bootstrap installs the drag handlers once via init_panel_resize().

export function init_panel_resize() {
  'use strict';

  const MIN_SIDEBAR_WIDTH = 150;
  // Approximate height of a fully-collapsed panel (title bar + borders + padding).
  const MIN_PANEL_HEIGHT = 50;

  // ── Horizontal sidebar resizer ─────────────────────────────────────────────

  const app_shell   = document.querySelector('.app');
  const sidebar_el  = document.getElementById('sidebar');
  const sidebar_resizer = document.getElementById('sidebar_resizer');

  if (sidebar_resizer && app_shell) {
    let h_dragging  = false;
    let h_start_x   = 0;
    let h_start_w   = 0;

    const sidebar_max = () => Math.max(MIN_SIDEBAR_WIDTH, Math.floor(window.innerWidth * 0.5));
    const sidebar_width = () => parseFloat(
      getComputedStyle(app_shell).getPropertyValue('--sidebar_width')
    ) || 320;
    const set_sidebar_width = (width) => {
      const value = Math.min(Math.max(width, MIN_SIDEBAR_WIDTH), sidebar_max());
      app_shell.style.setProperty('--sidebar_width', `${value}px`);
      sidebar_resizer.setAttribute('aria-valuenow', String(Math.round(value)));
      sidebar_resizer.setAttribute('aria-valuemax', String(sidebar_max()));
    };

    sidebar_resizer.addEventListener('pointerdown', (e) => {
      if (app_shell.classList.contains('sidebar_collapsed')) return;
      h_dragging = true;
      h_start_x  = e.clientX;
      // Read the current resolved value of --sidebar_width.
      h_start_w = sidebar_width();

      sidebar_resizer.classList.add('is_dragging');
      document.body.style.cursor     = 'col-resize';
      document.body.style.userSelect = 'none';
      // Suppress the CSS transition so the column follows the pointer instantly.
      app_shell.style.transition = 'none';
      sidebar_resizer.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });

    sidebar_resizer.addEventListener('pointermove', (e) => {
      if (!h_dragging) return;
      const delta   = e.clientX - h_start_x;
      set_sidebar_width(h_start_w + delta);
    });

    const end_sidebar_drag = () => {
      if (!h_dragging) return;
      h_dragging = false;
      sidebar_resizer.classList.remove('is_dragging');
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';
      app_shell.style.transition     = '';
      // Tell the plot (and anything else watching window resize) to redraw.
      window.dispatchEvent(new Event('resize'));
    };
    sidebar_resizer.addEventListener('pointerup', end_sidebar_drag);
    sidebar_resizer.addEventListener('pointercancel', end_sidebar_drag);
    sidebar_resizer.addEventListener('keydown', (event) => {
      if (app_shell.classList.contains('sidebar_collapsed')) return;
      const step = event.shiftKey ? 50 : 10;
      const value = {
        ArrowLeft: sidebar_width() - step,
        ArrowRight: sidebar_width() + step,
        PageDown: sidebar_width() - 50,
        PageUp: sidebar_width() + 50,
        Home: MIN_SIDEBAR_WIDTH,
        End: sidebar_max(),
        Enter: 320,
      }[event.key];
      if (value == null) return;
      event.preventDefault();
      set_sidebar_width(value);
      window.dispatchEvent(new Event('resize'));
    });
    window.addEventListener('resize', () => set_sidebar_width(sidebar_width()));
    set_sidebar_width(sidebar_width());
  }

  // ── Vertical workspace resizer ─────────────────────────────────────────────

  const workspace_resizer = document.getElementById('workspace_resizer');
  const plot_panel        = document.getElementById('plot_panel');
  const metadata_panel    = document.getElementById('metadata_panel');

  if (workspace_resizer && plot_panel && metadata_panel) {
    let v_dragging   = false;
    let v_start_y    = 0;
    let v_start_plot = 0;
    let v_start_meta = 0;

    const panel_total = () => plot_panel.getBoundingClientRect().height + metadata_panel.getBoundingClientRect().height;
    const set_panel_heights = (plot_height, total = panel_total()) => {
      const maximum = Math.max(MIN_PANEL_HEIGHT, total - MIN_PANEL_HEIGHT);
      const value = Math.min(Math.max(plot_height, MIN_PANEL_HEIGHT), maximum);
      plot_panel.style.flex = `0 0 ${value}px`;
      plot_panel.style.minHeight = '0';
      metadata_panel.style.flex = `0 0 ${total - value}px`;
      metadata_panel.style.minHeight = '0';
      workspace_resizer.setAttribute('aria-valuenow', String(Math.round(value)));
      workspace_resizer.setAttribute('aria-valuemax', String(Math.round(maximum)));
    };

    function sync_resizer_state() {
      const plot_hidden    = plot_panel.hasAttribute('hidden');
      const plot_collapsed = plot_panel.classList.contains('is_collapsed');
      const meta_collapsed = metadata_panel.classList.contains('is_collapsed');

      // When a panel enters a collapsed or hidden state, clear any inline flex
      // so the CSS default (flex: 1) takes over once it re-expands. Collapsing
      // the metadata table also clears the PLOT's inline flex: after a manual
      // resize the plot carries an explicit `flex: 0 0 <px>`, and without this
      // it would stay stuck at that height, leaving empty space below the
      // collapsed table instead of the plot expanding to fill the workspace.
      if (plot_collapsed || plot_hidden || meta_collapsed) {
        plot_panel.style.flex      = '';
        plot_panel.style.minHeight = '';
      }
      if (meta_collapsed) {
        metadata_panel.style.flex      = '';
        metadata_panel.style.minHeight = '';
      }

      const is_visible   = !plot_hidden;
      const is_draggable = is_visible && !plot_collapsed && !meta_collapsed;

      workspace_resizer.classList.toggle('visible',   is_visible);
      workspace_resizer.classList.toggle('draggable', is_draggable);
      workspace_resizer.setAttribute('aria-disabled', String(!is_draggable));
      if (is_draggable) {
        workspace_resizer.setAttribute('aria-valuenow', String(Math.round(plot_panel.getBoundingClientRect().height)));
        workspace_resizer.setAttribute('aria-valuemax', String(Math.round(Math.max(MIN_PANEL_HEIGHT, panel_total() - MIN_PANEL_HEIGHT))));
      }
    }

    // React to attribute/class changes on both panels.
    const panel_observer = new MutationObserver(sync_resizer_state);
    panel_observer.observe(plot_panel,     { attributes: true, attributeFilter: ['hidden', 'class'] });
    panel_observer.observe(metadata_panel, { attributes: true, attributeFilter: ['class'] });
    sync_resizer_state();

    workspace_resizer.addEventListener('pointerdown', (e) => {
      if (!workspace_resizer.classList.contains('draggable')) return;
      v_dragging   = true;
      v_start_y    = e.clientY;
      v_start_plot = plot_panel.getBoundingClientRect().height;
      v_start_meta = metadata_panel.getBoundingClientRect().height;

      workspace_resizer.classList.add('is_dragging');
      document.body.style.cursor     = 'row-resize';
      document.body.style.userSelect = 'none';
      workspace_resizer.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });

    workspace_resizer.addEventListener('pointermove', (e) => {
      if (!v_dragging) return;
      const delta = e.clientY - v_start_y;
      const total = v_start_plot + v_start_meta;
      set_panel_heights(v_start_plot + delta, total);
    });

    const end_panel_drag = () => {
      if (!v_dragging) return;
      v_dragging = false;
      workspace_resizer.classList.remove('is_dragging');
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';
      window.dispatchEvent(new Event('resize'));
    };
    workspace_resizer.addEventListener('pointerup', end_panel_drag);
    workspace_resizer.addEventListener('pointercancel', end_panel_drag);
    workspace_resizer.addEventListener('keydown', (event) => {
      if (!workspace_resizer.classList.contains('draggable')) return;
      const current = plot_panel.getBoundingClientRect().height;
      const total = panel_total();
      const value = {
        ArrowUp: current - 10,
        ArrowDown: current + 10,
        PageUp: current - 50,
        PageDown: current + 50,
        Home: MIN_PANEL_HEIGHT,
        End: total - MIN_PANEL_HEIGHT,
        Enter: total / 2,
      }[event.key];
      if (value == null) return;
      event.preventDefault();
      set_panel_heights(value, total);
      window.dispatchEvent(new Event('resize'));
    });
  }
}
