/**
 * Some MCP clients HTML-escape string arguments before they reach the server,
 * so "Housing & Utilities" arrives as "Housing &amp; Utilities" (or worse,
 * double-escaped). Actual stores names verbatim, so without this the entities
 * end up displayed literally in the UI. Unescape repeatedly until stable to
 * handle double-escapes like &amp;amp;.
 */
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'"
};

export function unescapeName(name: string): string {
  let current = name;
  for (let i = 0; i < 3; i++) {
    const next = current.replace(/&(?:amp|lt|gt|quot|#39|apos);/g, (m) => ENTITIES[m] ?? m);
    if (next === current) break;
    current = next;
  }
  return current;
}
