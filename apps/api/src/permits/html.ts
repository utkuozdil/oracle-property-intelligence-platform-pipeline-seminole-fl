/**
 * The narrow slice of HTML reading these two portals need.
 *
 * Deliberately not a DOM library. What is required is exact: round-trip every hidden
 * input on an ASP.NET WebForms page, slice one known table out by id, read a label/value
 * pair out of a Bootstrap form, and tell a visible validator span from a hidden one.
 * Those are a few hundred lines of scanning, against a dependency that would have to be
 * added to a shared `package.json` this agent does not own.
 */

const NAMED_ENTITIES: Record<string, string> = {
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  nbsp: '\u00a0',
  amp: '&',
};

/** `&amp;` is expanded last so `&amp;lt;` decodes to the literal `&lt;`, not to `<`. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Visible text of a fragment: tags dropped, entities decoded, whitespace collapsed. */
export function textOf(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Attributes of a single start tag. Handles double-quoted, single-quoted, unquoted, and
 * valueless attributes, in any order — WebForms emits all four shapes, so positional
 * matching on `type` then `name` then `value` is not safe.
 */
export function parseAttributes(startTag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([-\w:.]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  // Consume the tag name so it is not mistaken for a valueless attribute.
  pattern.exec(startTag);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(startTag)) !== null) {
    const [, name, doubleQuoted, singleQuoted, bare] = match;
    if (!name) continue;
    attributes[name.toLowerCase()] = decodeEntities(doubleQuoted ?? singleQuoted ?? bare ?? '');
  }
  return attributes;
}

/** Every start tag of one element name, as raw strings. */
export function startTags(html: string, tagName: string): string[] {
  const found: string[] = [];
  const pattern = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) found.push(match[0]);
  return found;
}

/**
 * Every `<input type="hidden">` on the page, as a name/value map.
 *
 * This is the whole viewstate contract. `__VIEWSTATE`, `__VIEWSTATEGENERATOR`, and
 * `__EVENTVALIDATION` must be posted back exactly as the server shipped them, and the
 * Telerik `_ClientState` fields ship empty and post fine empty.
 */
export function hiddenInputs(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const tag of startTags(html, 'input')) {
    const attributes = parseAttributes(tag);
    if ((attributes.type ?? '').toLowerCase() !== 'hidden') continue;
    const name = attributes.name;
    if (!name) continue;
    fields[name] = attributes.value ?? '';
  }
  return fields;
}

/**
 * The `<table>` carrying a given id, sliced out by counting `<table>`/`</table>` so a
 * nested table cannot end the slice early. Telerik nests tables several deep inside the
 * grid wrapper, so a lazy match to the first `</table>` truncates the rows.
 */
export function tableById(html: string, id: string): string | null {
  const marker = html.indexOf(`id="${id}"`);
  if (marker < 0) return null;
  const start = html.lastIndexOf('<table', marker);
  if (start < 0) return null;

  let depth = 0;
  const pattern = /<\/?table\b/gi;
  pattern.lastIndex = start;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(start, match.index);
  }
  return null;
}

export interface TableRow {
  classes: string[];
  cells: string[];
}

/** Rows of a table fragment, each as its `<tr>` classes plus its cells' visible text. */
export function tableRows(tableFragment: string): TableRow[] {
  const rows: TableRow[] = [];
  const pattern = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tableFragment)) !== null) {
    const attributes = parseAttributes(`<tr ${match[1] ?? ''}>`);
    const cells = [...(match[2] ?? '').matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) =>
      textOf(cell[1] ?? ''),
    );
    rows.push({
      classes: (attributes.class ?? '').split(/\s+/).filter(Boolean),
      cells,
    });
  }
  return rows;
}

export interface VisibleSpan {
  text: string;
  visible: boolean;
}

/**
 * A span's text together with whether the server left it visible.
 *
 * Load-bearing for Source A. ASP.NET renders every validator span up front, carrying its
 * error message, and suppresses it with `visibility:hidden` until it fires — so "the span
 * has text" is true on a perfectly good response and cannot be the rejection signal.
 */
export function spanById(html: string, id: string): VisibleSpan | null {
  const marker = html.indexOf(`id="${id}"`);
  if (marker < 0) return null;
  const openStart = html.lastIndexOf('<span', marker);
  const openEnd = html.indexOf('>', marker);
  if (openStart < 0 || openEnd < 0) return null;

  const style = (parseAttributes(html.slice(openStart, openEnd + 1)).style ?? '')
    .replace(/\s+/g, '')
    .toLowerCase();
  const hidden = style.includes('visibility:hidden') || style.includes('display:none');
  const close = html.indexOf('</span>', openEnd);
  return {
    text: close < 0 ? '' : textOf(html.slice(openEnd + 1, close)),
    visible: !hidden,
  };
}

/**
 * Click2Gov detail pages, which are a Bootstrap grid rather than a table:
 *
 *   <label ...><span>*</span><span>Application Date:</span></label>
 *   <div ...><p class="form-control-static">08/26/26</p></div>
 *
 * A field with no value still renders the `<p>`, and an empty `<p>` must not let the
 * following field's value slide up into it — so a candidate value is only accepted when
 * it appears before the next `<label>`.
 */
export function staticFormFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const labelPattern = /<label\b[^>]*>([\s\S]*?)<\/label>/gi;
  let match: RegExpExecArray | null;
  while ((match = labelPattern.exec(html)) !== null) {
    const spans = [...(match[1] ?? '').matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)]
      .map((span) => textOf(span[1] ?? ''))
      .filter((text) => text.length > 0 && text !== '*');
    const label = (spans.at(-1) ?? '').replace(/:$/, '').trim();
    if (!label || label in fields) continue;

    const rest = html.slice(match.index + match[0].length);
    const value = /<p\b[^>]*class="[^"]*form-control-static[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(rest);
    if (!value) continue;
    const nextLabel = rest.search(/<label\b/i);
    fields[label] = nextLabel >= 0 && value.index > nextLabel ? '' : textOf(value[1] ?? '');
  }
  return fields;
}

/** The `<title>` text, used to tell a real detail page from Click2Gov's error page. */
export function pageTitle(html: string): string | null {
  const match = /<title>([\s\S]*?)<\/title>/i.exec(html);
  return match ? textOf(match[1] ?? '') : null;
}
