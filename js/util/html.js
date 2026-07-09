// Small shared HTML helpers. This leaf module holds string utilities that are
// used across the UI, IO, and status layers when building table, progress, and
// wizard markup by hand. It escapes HTML-special characters so untrusted values
// (filenames, imported metadata, channel labels) can be safely interpolated into
// markup strings. It deliberately pulls in no DOM or app state and imports
// nothing, so any module can import it without creating a dependency cycle. The
// plotting layer keeps its own copy (plot_escape_html) so it never has to reach
// across into the UI utilities.

/*

Purpose:
	Escapes HTML-special characters in a value so it can be safely interpolated
	into table/markup strings.

Input:
	value [any]: the value to escape (coerced to a string)

Output:
	escaped [string]: the HTML-escaped string

*/
export function escape_html(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
