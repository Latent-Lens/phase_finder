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

    sidebar_resizer.addEventListener('mousedown', (e) => {
      if (app_shell.classList.contains('sidebar_collapsed')) return;
      h_dragging = true;
      h_start_x  = e.clientX;
      // Read the current resolved value of --sidebar_width.
      h_start_w  = parseFloat(
        getComputedStyle(app_shell).getPropertyValue('--sidebar_width')
      ) || 320;

      sidebar_resizer.classList.add('is_dragging');
      document.body.style.cursor     = 'col-resize';
      document.body.style.userSelect = 'none';
      // Suppress the CSS transition so the column follows the pointer instantly.
      app_shell.style.transition = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!h_dragging) return;
      const max_w   = Math.floor(window.innerWidth * 0.5);
      const delta   = e.clientX - h_start_x;
      const new_w   = Math.min(Math.max(h_start_w + delta, MIN_SIDEBAR_WIDTH), max_w);
      app_shell.style.setProperty('--sidebar_width', `${new_w}px`);
    });

    document.addEventListener('mouseup', () => {
      if (!h_dragging) return;
      h_dragging = false;
      sidebar_resizer.classList.remove('is_dragging');
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';
      app_shell.style.transition     = '';
      // Tell the plot (and anything else watching window resize) to redraw.
      window.dispatchEvent(new Event('resize'));
    });
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

    function sync_resizer_state() {
      const plot_hidden    = plot_panel.hasAttribute('hidden');
      const plot_collapsed = plot_panel.classList.contains('is_collapsed');
      const meta_collapsed = metadata_panel.classList.contains('is_collapsed');

      // When a panel enters a collapsed or hidden state, clear any inline flex
      // so the CSS default (flex: 1) takes over once it re-expands.
      if (plot_collapsed || plot_hidden) {
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
    }

    // React to attribute/class changes on both panels.
    const panel_observer = new MutationObserver(sync_resizer_state);
    panel_observer.observe(plot_panel,     { attributes: true, attributeFilter: ['hidden', 'class'] });
    panel_observer.observe(metadata_panel, { attributes: true, attributeFilter: ['class'] });
    sync_resizer_state();

    workspace_resizer.addEventListener('mousedown', (e) => {
      if (!workspace_resizer.classList.contains('draggable')) return;
      v_dragging   = true;
      v_start_y    = e.clientY;
      v_start_plot = plot_panel.getBoundingClientRect().height;
      v_start_meta = metadata_panel.getBoundingClientRect().height;

      workspace_resizer.classList.add('is_dragging');
      document.body.style.cursor     = 'row-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!v_dragging) return;
      const delta = e.clientY - v_start_y;
      const total = v_start_plot + v_start_meta;

      let new_plot = v_start_plot + delta;
      let new_meta = v_start_meta - delta;

      // Clamp so neither panel drops below its minimum height.
      if (new_plot < MIN_PANEL_HEIGHT) {
        new_plot = MIN_PANEL_HEIGHT;
        new_meta = total - MIN_PANEL_HEIGHT;
      } else if (new_meta < MIN_PANEL_HEIGHT) {
        new_meta = MIN_PANEL_HEIGHT;
        new_plot = total - MIN_PANEL_HEIGHT;
      }

      plot_panel.style.flex      = `0 0 ${new_plot}px`;
      plot_panel.style.minHeight = '0';
      metadata_panel.style.flex      = `0 0 ${new_meta}px`;
      metadata_panel.style.minHeight = '0';
    });

    document.addEventListener('mouseup', () => {
      if (!v_dragging) return;
      v_dragging = false;
      workspace_resizer.classList.remove('is_dragging');
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';
      window.dispatchEvent(new Event('resize'));
    });
  }
}
