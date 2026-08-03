#!/usr/bin/env Rscript
# Fit the FlowJo reference samples with flowPloidy (Bioconductor).
#
# Why this tool specifically: of the mainstream open-source flow packages,
# flowPloidy is the only one that actually MODELS a DNA-content histogram rather
# than reading, transforming or gating it. It fits Gaussian peaks plus an
# explicit debris model (single-cut / multi-cut) and, in its default
# configuration, an S-phase term -- so unlike a bare Gaussian mixture it is a
# genuine model-vs-model comparison against Dean-Jett-Fox.
#
# It is NOT Dean-Jett-Fox: flowPloidy is built for genome size / ploidy work and
# models S phase as a broadened polynomial between the peaks rather than DJF's
# convolved occupancy with a Fox cohort term. So agreement on PEAK POSITIONS is
# the meaningful signal here; %S may legitimately differ on model grounds, the
# same way Flowreader's classic Watson legitimately differs from ours.
#
# Writes results/flowploidy.json for the shared HTML report.

suppressPackageStartupMessages({
  local_lib <- file.path("tests", "external_tools", "rlib")
  if (dir.exists(local_lib)) .libPaths(c(local_lib, .libPaths()))
})

args <- commandArgs(trailingOnly = TRUE)
limit <- if (length(args) >= 1) as.integer(args[1]) else NA

data_dir <- file.path("..", "test_flow_data", "Asynchronous_UsedAsFloJoDFJSampleDataset")
out_path <- file.path("tests", "external_tools", "results", "flowploidy.json")

ok <- requireNamespace("flowPloidy", quietly = TRUE) &&
      requireNamespace("flowCore", quietly = TRUE) &&
      requireNamespace("jsonlite", quietly = TRUE)
if (!ok) {
  cat("flowPloidy / flowCore / jsonlite not available; skipping.\n")
  quit(status = 0)
}
suppressPackageStartupMessages({
  library(flowPloidy); library(flowCore); library(jsonlite)
})

files <- sort(list.files(data_dir, pattern = "\\.fcs$", full.names = TRUE))
if (!is.na(limit)) files <- head(files, limit)
cat(sprintf("flowPloidy over %d samples\n", length(files)))

# The DNA channel the FlowJo reference set is pinned to (SYTOX Green).
dna_pattern <- "GFP|FITC|FL7"

rows <- list()
for (i in seq_along(files)) {
  path <- files[i]
  name <- basename(path)
  entry <- list(file = name)

  result <- tryCatch({
    frame <- read.FCS(path, transformation = FALSE, truncate_max_range = FALSE)
    channels <- colnames(frame)
    dna <- grep(dna_pattern, channels, value = TRUE, ignore.case = TRUE)
    if (length(dna) == 0) stop(paste("no DNA channel among:", paste(head(channels, 8), collapse = ", ")))
    dna <- dna[1]

    # flowPloidy works from a histogram of the DNA channel.
    fh <- FlowHist(FILE = path, CHANNEL = dna)
    fh <- fhAnalyze(fh)

    counts <- fhCounts(fh)
    ratio <- tryCatch(fhRatios(fh), error = function(e) NULL)
    list(
      channel = dna,
      events = as.integer(nrow(frame)),
      counts = as.list(counts),
      ratio = if (is.null(ratio)) NULL else as.list(ratio),
      cv = tryCatch(as.list(fhCV(fh)), error = function(e) NULL),
      rcs = tryCatch(as.numeric(fhRCS(fh)), error = function(e) NA_real_),
      components = tryCatch(names(fhComps(fh)), error = function(e) NULL)
    )
  }, error = function(e) list(error = conditionMessage(e)))

  entry <- c(entry, result)
  rows[[length(rows) + 1]] <- entry
  cat(sprintf("[%d/%d] %s %s\n", i, length(files), name,
              if (!is.null(result$error)) paste("ERR", substr(result$error, 1, 70)) else "ok"))
}

dir.create(dirname(out_path), recursive = TRUE, showWarnings = FALSE)
write(toJSON(rows, auto_unbox = TRUE, null = "null", na = "null", pretty = TRUE), out_path)
cat(sprintf("\nwrote %s\n", out_path))
