export const legacyShellHtml = `
    <header class="page_header">
      <div class="header_brand">
        <img id="site_logo" class="site_logo" src="./assets/img/logo.png" alt="PhaseFinder" data-title-key="reloadLogo" />
      </div>
      <div class="header_actions">
        <a
          id="help_link"
          class="help_link quick_tooltip"
          href="./help.html"
          target="_blank"
          rel="noopener"
          data-tooltip-key="help"
        >
          Help
        </a>
        <button
          id="load_session_button"
          class="load_session_button quick_tooltip"
          type="button"
          data-tooltip-key="loadSession"
        >
          Load session
        </button>
        <button
          id="save_session_button"
          class="save_session_button quick_tooltip"
          type="button"
          data-tooltip-key="saveSession"
        >
          Save session
        </button>
      </div>
    </header>

    <main class="app">
      <aside id="sidebar" class="sidebar panel">
        <div class="sidebar_header panel_title">
          <div class="sidebar_title_row">
            <h2>FCS Files</h2>
            <button id="sidebar_toggle" class="sidebar_toggle quick_tooltip" type="button" aria-controls="sidebar_content" aria-expanded="true" data-tooltip-key="sidebarCollapse" aria-label="Collapse sidebar">
              <img id="sidebar_toggle_icon" class="sidebar_toggle_icon" src="./assets/img/sidepanel_close.svg" alt="" aria-hidden="true" />
            </button>
          </div>
          <div class="panel_title_rule"></div>
        </div>
        <div id="sidebar_content" class="sidebar_content">
          <section id="file_upload_section" class="sidebar_section file_upload_section">
            <div id="loaded_files_panel" class="loaded_files_panel" hidden>
              <label id="loaded_files_label" for="loaded_files_list">Loaded FCS files (0)</label>
              <textarea id="loaded_files_list" class="loaded_files_list" readonly wrap="off" spellcheck="false"></textarea>
            </div>
            <div id="drop_zone" class="drop_zone">
              <div>
                <strong id="drop_zone_title">Drop FCS files here</strong>
                <span id="drop_zone_hint">or click to choose files from disk</span>
              </div>
            </div>
          </section>

          <section class="sidebar_section controls">
            <div>
              <label for="channel_select">Select channel</label>
              <select id="channel_select"></select>
            </div>
            <p id="status" class="status">No files loaded.</p>
            <button
              id="start_analysis_button"
              class="start_analysis_button sidebar_plot_button quick_tooltip"
              type="button"
              data-tooltip-key="plotChannelEventsRequirements"
              disabled
            >
              Plot Channel Events
            </button>
            <button
              id="cell_cycle_modeling_button"
              class="cell_cycle_modeling_button sidebar_plot_button quick_tooltip"
              type="button"
              data-tooltip-key="cellCycleModelingDisabled"
              disabled
            >
              Cell Cycle Modeling
            </button>
            <button
              id="calculate_stats_button"
              class="calculate_stats_button sidebar_plot_button quick_tooltip"
              type="button"
              data-tooltip-key="calculateStats"
              disabled
            >
              Calculate Statistics
            </button>
          </section>
        </div>
        <input id="file_input" class="visually_hidden_file" type="file" accept=".fcs" multiple />
        <div class="sidebar_collapsed_actions">
          <button id="collapsed_upload_target" class="sidebar_collapsed_upload_target quick_tooltip" type="button" data-tooltip-key="uploadFiles" aria-label="Drop FCS files here or click to choose files from disk">
            <img class="sidebar_collapsed_upload_icon" src="./assets/img/file_upload.svg" alt="" aria-hidden="true" />
          </button>
          <div class="sidebar_collapsed_channel_control quick_tooltip" data-tooltip-key="selectChannel">
            <img class="sidebar_collapsed_checklist_icon" src="./assets/img/checklist.svg" alt="" aria-hidden="true" />
            <select id="collapsed_channel_select" class="sidebar_collapsed_channel_select" aria-label="Select channel"></select>
          </div>
          <button id="collapsed_plot_button" class="sidebar_collapsed_plot_button quick_tooltip" type="button" data-tooltip-key="plotChannelEvents" aria-label="Plot channel events" disabled>
            <img class="sidebar_collapsed_histogram_icon" src="./assets/img/histogram.svg" alt="" aria-hidden="true" />
          </button>
          <button id="collapsed_cell_cycle_modeling_button" class="sidebar_collapsed_plot_button quick_tooltip" type="button" data-tooltip-key="cellCycleModelingDisabled" aria-label="Cell cycle modeling (disabled until channel is plotted)" disabled>
            <img class="sidebar_collapsed_function_icon" src="./assets/img/function_icon.svg" alt="" aria-hidden="true" />
          </button>
          <button id="collapsed_calculate_stats_button" class="sidebar_collapsed_plot_button quick_tooltip" type="button" data-tooltip-key="calculateStats" aria-label="Calculate statistics" disabled>
            <img class="sidebar_collapsed_calculator_icon" src="./assets/img/calculator.svg" alt="" aria-hidden="true" />
          </button>
        </div>
      </aside>

      <div id="sidebar_resizer" class="sidebar_resizer" aria-hidden="true"></div>

      <section class="workspace">
        <section id="plot_panel" class="panel parsed_files_panel plot_panel" hidden>
          <div class="panel_title">
            <div class="metadata_title_row">
              <span class="metadata_title_text" id="plot_title">Histogram of Events</span>
              <button id="plot_panel_toggle" class="panel_icon_toggle quick_tooltip" type="button" aria-expanded="true" aria-controls="plot_panel_body" data-tooltip-key="plotCollapse" aria-label="Collapse plot">
                <img id="plot_panel_toggle_icon" class="panel_toggle_icon" src="./assets/img/table_minimize.svg" alt="" aria-hidden="true" />
              </button>
            </div>
            <span class="panel_title_rule"></span>
          </div>
          <div id="plot_panel_body" class="metadata_panel_body">
            <div class="plot_panel_inner">
            <div class="plot_controls">
              <label class="plot_control">Color by
                <select id="plot_color_by">
                  <option value="file">File</option>
                  <option value="strain">Strain</option>
                </select>
              </label>
              <label class="plot_control">Bins
                <input id="plot_bins" type="number" min="16" max="1024" step="16" value="512" />
              </label>
              <label class="plot_control plot_control_check">
                <span class="plot_check_row">
                  <input type="checkbox" id="plot_debris_correction" />
                  Remove debris/background
                  <span
                    class="info_icon"
                    tabindex="0"
                    role="img"
                    aria-label="Debris and background correction help"
                    data-tooltip-key="debrisHelp"
                  >?</span>
                </span>
              </label>
              <label class="plot_control plot_control_check">
                <span class="plot_check_row">
                  <input type="checkbox" id="plot_doublet_correction" />
                  Remove aggregates/doublets
                  <span
                    class="info_icon"
                    tabindex="0"
                    role="img"
                    aria-label="Aggregate and doublet correction help"
                    data-tooltip-key="doubletHelp"
                  >?</span>
                </span>
              </label>
              <label class="plot_control plot_control_check">
                <span class="plot_check_row">
                  <input type="checkbox" id="plot_threshold_toggle" />
                  Peak threshold
                  <span
                    class="info_icon"
                    tabindex="0"
                    role="img"
                    aria-label="Peak threshold help"
                    data-tooltip-key="peakThresholdHelp"
                  >?</span>
                </span>
              </label>
              <span id="djf_readout" class="djf_readout"></span>
            </div>
            <div id="plot_area" class="table_wrap"></div>
            </div>
          </div>
        </section>

        <div id="workspace_resizer" class="workspace_resizer" aria-hidden="true"></div>

        <section id="metadata_panel" class="panel parsed_files_panel">
          <div class="panel_title metadata_title">
            <div class="metadata_title_row">
              <span class="metadata_title_text">Table of Loaded FCS Samples</span>
              <div class="metadata_title_actions">
                <button id="metadata_parse_button" class="panel_icon_toggle quick_tooltip" type="button" data-tooltip-key="configureMetadata" aria-label="Configure filename metadata columns" disabled>
                  <img class="panel_toggle_icon" src="./assets/img/text_to_col.svg" alt="" aria-hidden="true" />
                </button>
                <button id="metadata_export_button" class="panel_icon_toggle quick_tooltip" type="button" data-tooltip-key="exportTable" aria-label="Export table as TSV" disabled>
                  <img class="panel_toggle_icon" src="./assets/img/table_export.svg" alt="" aria-hidden="true" />
                </button>
                <button id="metadata_panel_toggle" class="panel_icon_toggle quick_tooltip" type="button" aria-expanded="true" aria-controls="metadata_panel_body" data-tooltip-key="tableCollapse" aria-label="Collapse table">
                  <img id="metadata_panel_toggle_icon" class="panel_toggle_icon" src="./assets/img/table_minimize.svg" alt="" aria-hidden="true" />
                </button>
              </div>
            </div>
            <span class="panel_title_rule"></span>
          </div>
          <div id="metadata_panel_body" class="metadata_panel_body">
            <div id="file_table" class="table_wrap"></div>
          </div>
        </section>
      </section>
    </main>

    <div id="metadata_wizard_modal" class="stats_modal metadata_wizard_modal" hidden role="dialog" aria-modal="true" aria-labelledby="metadata_wizard_title">
      <div class="stats_modal_backdrop"></div>
      <div class="stats_modal_card metadata_wizard_card">
        <div class="stats_modal_header">
          <h3 id="metadata_wizard_title" class="stats_modal_title">Filename Metadata Columns</h3>
          <button id="metadata_wizard_close" class="stats_modal_close" type="button" aria-label="Close">&times;</button>
        </div>
        <div class="stats_modal_body metadata_wizard_body">
          <div class="metadata_split_panel">
            <div class="metadata_split_panel_header">
              <span>Filename Split Steps</span>
              <button id="metadata_add_split_step" type="button">Add Step</button>
            </div>
            <div id="metadata_split_steps" class="metadata_split_steps"></div>
            <div id="metadata_column_editor" class="metadata_column_editor"></div>
          </div>
          <div class="metadata_preview_wrap">
            <div class="metadata_preview_title">Preview</div>
            <div id="metadata_preview" class="metadata_preview"></div>
          </div>
          <div class="stats_modal_actions metadata_wizard_actions">
            <button id="metadata_wizard_reset" type="button" class="secondary_button">Filename Only</button>
            <button id="metadata_wizard_cancel" type="button" class="secondary_button">Cancel</button>
            <button id="metadata_wizard_apply" type="button">Apply</button>
          </div>
        </div>
      </div>
    </div>

    <div id="stats_modal" class="stats_modal" hidden role="dialog" aria-modal="true" aria-labelledby="stats_modal_title">
      <div class="stats_modal_backdrop"></div>
      <div class="stats_modal_card">
        <div class="stats_modal_header">
          <h3 id="stats_modal_title" class="stats_modal_title">Calculate Statistics</h3>
          <button id="stats_modal_close" class="stats_modal_close" type="button" aria-label="Close">&times;</button>
        </div>
        <div class="stats_modal_body">
          <div class="stats_form_row">
            <label for="stats_channel_select">Channel</label>
            <select id="stats_channel_select"></select>
          </div>
          <div class="stats_form_row">
            <span class="stats_label">Statistics</span>
            <div class="stats_checkboxes">
              <label class="stats_check"><input type="checkbox" name="stat" value="mean" checked> Mean</label>
              <label class="stats_check"><input type="checkbox" name="stat" value="stddev" checked> Std Dev</label>
              <label class="stats_check"><input type="checkbox" name="stat" value="median"> Median</label>
              <label class="stats_check"><input type="checkbox" name="stat" value="min"> Min</label>
              <label class="stats_check"><input type="checkbox" name="stat" value="max"> Max</label>
              <label class="stats_check stats_check_all"><input type="checkbox" name="stat" value="all"> All</label>
            </div>
          </div>
          <div class="stats_modal_actions">
            <button id="stats_calculate_button" type="button">Calculate</button>
          </div>
          <div id="stats_progress_indicator" class="stats_progress" hidden>
            <div class="stats_progress_track">
              <div id="stats_progress_bar" class="stats_progress_bar"></div>
            </div>
            <span id="stats_progress_label" class="stats_progress_label"></span>
          </div>
        </div>
      </div>
    </div>

    <div id="reconnect_modal" class="stats_modal reconnect_modal" hidden role="dialog" aria-modal="true" aria-labelledby="reconnect_title">
      <div class="stats_modal_backdrop"></div>
      <div class="stats_modal_card">
        <div class="stats_modal_header">
          <h3 id="reconnect_title" class="stats_modal_title">Reconnect Session Files</h3>
          <button id="reconnect_close" class="stats_modal_close" type="button" aria-label="Close">&times;</button>
        </div>
        <div class="stats_modal_body">
          <p id="reconnect_intro" class="reconnect_intro"></p>
          <ul id="reconnect_file_list" class="reconnect_file_list"></ul>
          <div class="stats_modal_actions reconnect_actions">
            <button id="reconnect_choose_folder" type="button" class="secondary_button">Choose folder</button>
            <button id="reconnect_select_files" type="button" class="secondary_button">Select files</button>
            <button id="reconnect_cancel" type="button" class="secondary_button">Cancel</button>
            <button id="reconnect_continue" type="button">Continue without missing</button>
          </div>
          <input id="reconnect_file_input" class="visually_hidden_file" type="file" accept=".fcs" multiple />
        </div>
      </div>
    </div>

    <div id="progress_overlay" class="progress_overlay" hidden aria-live="polite" aria-busy="false">
      <div class="progress_card" role="status">
        <div class="progress_track" aria-hidden="true">
          <div id="progress_fill" class="progress_fill"></div>
        </div>
        <div class="progress_meta">
          <span id="progress_label">Loading FCS Metadata</span>
          <span id="progress_percent">0%</span>
        </div>
        <div id="progress_detail" class="progress_detail"></div>
      </div>
    </div>

    <footer id="status_bar" class="status_bar">
      <span id="status_bar_message" class="status_bar_message">Ready.</span>
      <span class="status_bar_copyright">
        © 2026 <a href="https://latentlens.org">LatentLens</a>. All rights reserved
      </span>
    </footer>`;
