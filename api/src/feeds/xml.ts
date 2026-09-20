/**
 * A very small XML reader, enough for RSS 2.0 and Atom and nothing more.
 *
 * Written by hand rather than pulled in, for the same reason `rules/tz.ts` does
 * its own timezone math: this runs in the Lambda bundle on a schedule, the
 * surface it needs is four functions wide, and a feed parser is the one place
 * where "tolerant of malformed input" has to be a deliberate property rather
 * than whatever the dependency happens to do this major version.
 *
 * Tolerance here means: unknown entities are left alone, a mismatched close tag
 * unwinds to the matching open if there is one and is otherwise ignored, and an
 * unterminated tag ends the document instead of throwing. A feed that is 90%
 * well-formed should yield 90% of its items.
 */

export type XmlNode = {
  /** Local name, lowercased, with any namespace prefix kept: `media:thumbnail`. */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Direct text content, concatenated across text and CDATA runs. */
  text: string;
};

const VOID_END = /^[\s/>]/;

export function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;

  const top = () => stack[stack.length - 1]!;

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      top().text += decodeEntities(source.slice(i));
      break;
    }
    if (lt > i) top().text += decodeEntities(source.slice(i, lt));

    // `<!` covers comments, CDATA and doctype; `<?` covers the XML declaration
    // and processing instructions. None of them contribute nodes, but CDATA
    // contributes text, and dropping it loses most titles in a WordPress feed.
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt);
      if (end === -1) { top().text += source.slice(lt + 9); break; }
      top().text += source.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<!', lt) || source.startsWith('<?', lt)) {
      const end = source.indexOf('>', lt);
      i = end === -1 ? source.length : end + 1;
      continue;
    }

    if (source.startsWith('</', lt)) {
      const end = source.indexOf('>', lt);
      if (end === -1) break;
      const name = source.slice(lt + 2, end).trim().toLowerCase();
      // Unwind to the matching open tag if it is anywhere in the stack; a close
      // tag with no open is stray markup and is dropped rather than closing
      // whatever happens to be current.
      const at = stack.findIndex((n) => n.name === name);
      if (at > 0) stack.length = at;
      i = end + 1;
      continue;
    }

    const end = findTagEnd(source, lt);
    if (end === -1) break;
    const inner = source.slice(lt + 1, end);
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;

    let cut = 0;
    while (cut < body.length && !VOID_END.test(body[cut]!)) cut += 1;
    const name = body.slice(0, cut).toLowerCase();
    if (!name) { i = end + 1; continue; }

    const node: XmlNode = { name, attrs: parseAttrs(body.slice(cut)), children: [], text: '' };
    top().children.push(node);
    if (!selfClosing) stack.push(node);
    i = end + 1;
  }

  return root;
}

/**
 * The `>` that ends a tag, skipping any inside a quoted attribute value.
 *
 * `<link href="a>b"/>` is rare but legal, and cutting at the first `>` turns
 * the rest of the attribute into a bogus element name.
 */
function findTagEnd(s: string, from: number): number {
  let quote = '';
  for (let i = from + 1; i < s.length; i += 1) {
    const ch = s[i]!;
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

const ATTR = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(ATTR)) {
    out[m[1]!.toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return out;
}

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
};

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    const b = body.toLowerCase();
    if (b.startsWith('#x')) {
      const n = parseInt(b.slice(2), 16);
      return Number.isFinite(n) ? safeCodePoint(n, whole) : whole;
    }
    if (b.startsWith('#')) {
      const n = parseInt(b.slice(1), 10);
      return Number.isFinite(n) ? safeCodePoint(n, whole) : whole;
    }
    // An unknown entity is left verbatim. Replacing it with a placeholder would
    // corrupt titles that legitimately contain `&something;`.
    return NAMED[b] ?? whole;
  });
}

function safeCodePoint(n: number, whole: string): string {
  if (n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return whole;
  return String.fromCodePoint(n);
}

// ---------- tree helpers ----------

/** Every descendant with this tag name, in document order. */
export function findAll(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.name === name) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

/** The first descendant with any of these tag names, preferring the earlier names. */
export function find(node: XmlNode, ...names: string[]): XmlNode | undefined {
  for (const name of names) {
    const hit = findAll(node, name)[0];
    if (hit) return hit;
  }
  return undefined;
}

/** Collapsed text of a node and everything under it. */
export function textOf(node: XmlNode | undefined): string {
  if (!node) return '';
  let out = node.text;
  for (const c of node.children) out += textOf(c);
  return out.replace(/\s+/g, ' ').trim();
}

/** Text of the first matching child element, collapsed. */
export function childText(node: XmlNode, ...names: string[]): string {
  return textOf(find(node, ...names));
}

/** Strips tags from a description that arrived as escaped or embedded HTML. */
export function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
