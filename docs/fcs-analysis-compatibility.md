# FCS analysis compatibility

The release-gating, machine-readable matrix is
[`fcs-compatibility.json`](./fcs-compatibility.json). Every matrix cell names
the conformance fixtures that prove its supported or rejected behavior.

PhaseFinder can import metadata from a broader range of files than it permits
for DNA-content analysis. The selected DNA channel must pass the production
`FCSParser.channel_eligibility()` contract before DATA values are loaded.

Supported for event analysis:

- FCS 2.0, 3.0, and 3.1;
- list mode (`$MODE=L`);
- `$DATATYPE` F and D with supported byte orders, or byte-aligned I parameters
  no wider than JavaScript's exact 53-bit integer range;
- a positive `$PnR`, linear `$PnE` (`0,0`), and unit or absent `$PnG`;
- one dataset (`$NEXTDATA` absent or zero);
- a selected DNA channel that does not participate in a declared `$SPILLOVER`,
  `$SPILL`, or `$COMP` matrix.

Supplemental TEXT is rejected with `FCS_SUPPLEMENTAL_TEXT_UNSUPPORTED`; required
keywords must be in the primary TEXT segment.

PhaseFinder does not currently transform logarithmic/gained DNA values or apply
spillover compensation. Those cases remain importable for inspection but are
blocked from histogram, QC, peak, and model actions with a typed explanation.
This fail-closed policy also prevents a session/cache restore from applying a
transformation or compensation twice.

The eligibility descriptor uses explicit machine-readable states. Transform is
`linear`, `transformed_supported`, `transformed_unsupported`, or `unknown`;
compensation is `compensated`, `uncompensated`, `not_applicable`, or `unknown`.
The current policy only accepts `linear` input and never reports that PhaseFinder
itself applied a transform or compensation (`applicationCount` remains zero).
The descriptor is shown beside the channel selector and retained in model,
session, and HTML-report provenance.

Parser allocations are bounded by the mutable `FCSParser.limits` values. The
defaults cap parameters, events, TEXT size and keyword count/length, DATA size,
selected-column working memory, and chunk input size. DATA is decoded from
event-aligned Blob chunks; load provenance records chunks, source/retained/
transferred bytes, peak resident input bytes, and parse time. Limit failures and
malformed offsets return typed errors without copying FCS metadata into the message.

## Release gate

Any compatibility change must update the JSON matrix and its named fixtures.
Release checks run the browser parser suite plus:

```sh
python3 tests/validation/validation_test_data/synthetic_fcs/generate_fixtures.py --check
python3 tests/validation/driving_code/generate_flowio_reference.py --check
```
