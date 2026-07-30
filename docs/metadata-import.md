# Metadata import

PhaseFinder accepts CSV and TSV metadata with quoted delimiters, quoted quotes,
empty cells, and CRLF or LF line endings. The first row is the header row.

Headers must be unique after trimming, case folding, and removing punctuation
and whitespace. For example, `Treatment`, ` treatment `, and `TREAT-MENT`
collide. The import is rejected before any table state changes, with the two
source column numbers in the error. PhaseFinder does not silently rename or
overwrite duplicate source columns.
