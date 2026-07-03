<script>
  import { onMount, tick } from "svelte";
  import { legacyShellHtml } from "./lib/legacyShell.js";
  import { installThirdPartyGlobals } from "./lib/thirdParty.js";
  import { loadLegacyScripts } from "./lib/legacyLoader.js";

  let startupError = "";

  onMount(async () => {
    await tick();
    try {
      await installThirdPartyGlobals();
      await loadLegacyScripts();
    } catch (error) {
      startupError = error?.message || String(error);
      console.error("PhaseFinder failed to start:", error);
    }
  });
</script>

{@html legacyShellHtml}

{#if startupError}
  <div class="status_bar status_bar__error" role="alert">
    PhaseFinder startup failed: {startupError}
  </div>
{/if}
