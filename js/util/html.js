// Small shared HTML helpers. This leaf module holds string utilities that are
// used across the UI, IO, and status layers without pulling in any DOM or app
// state. It imports nothing so it can be imported anywhere without creating a
// dependency cycle.

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
