import { derived, writable } from "svelte/store";

export const sampleEntries = writable(new Map());
export const selectedSampleIds = writable(new Set());
export const selectedChannel = writable("");
export const statusMessage = writable("No files loaded.");
export const statusError = writable(false);
export const progressState = writable({
  visible: false,
  label: "Loading FCS Metadata",
  percent: 0,
  detail: "",
});

export const selectedSamples = derived(
  [sampleEntries, selectedSampleIds],
  ([$sampleEntries, $selectedSampleIds]) =>
    [...$selectedSampleIds]
      .map((id) => $sampleEntries.get(id))
      .filter(Boolean),
);

export function setSamples(entries) {
  sampleEntries.set(new Map(entries.map((entry) => [entry.id, entry])));
}

export function appendSamples(entries) {
  sampleEntries.update((current) => {
    const next = new Map(current);
    entries.forEach((entry) => next.set(entry.id, entry));
    return next;
  });
}

export function selectSamples(ids) {
  selectedSampleIds.set(new Set(ids));
}

export function setStatus(message, isError = false) {
  statusMessage.set(message);
  statusError.set(Boolean(isError));
}

export function showProgress(label = "Loading FCS Metadata") {
  progressState.set({
    visible: true,
    label,
    percent: 0,
    detail: "",
  });
}

export function updateProgress(percent, label = "Loading FCS Metadata", detail = "") {
  progressState.update((current) => ({
    ...current,
    visible: true,
    label,
    percent,
    detail,
  }));
}

export function hideProgress() {
  progressState.update((current) => ({
    ...current,
    visible: false,
  }));
}
