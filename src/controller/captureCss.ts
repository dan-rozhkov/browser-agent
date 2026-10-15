// browse_capture v2 (2026-10-15): the Node-side CSS pipeline of `capture`.
// Pure functions over strings and postcss ASTs: no DOM, no page access. The
// controller feeds it the style sources CAPTURE_JS reported, fetches the
// linked / imported files through the page handle, asks the page which
// selectors still match, and gets one finished <style> body per source back.
// Spec: pen-editor-backend/docs/specs/2026-10-15-browse-capture-design.md
// ("v2, steps 1-2").
import { AtRule, parse } from "postcss";
import type { ChildNode, Container, Root, Rule } from "postcss";
import selectorParser from "postcss-selector-parser";

export type CaptureSource =
  | { kind: "link"; href: string; media: string }
  | { kind: "inline"; text: string; baseUrl: string; media: string }
  | { kind: "adopted"; text: string; baseUrl: string };

export type FetchText = (
  url: string,
  opts: { timeoutMs: number; maxBytes: number; signal?: AbortSignal },
) => Promise<{ status: number; text: string; contentType?: string }>;

export interface ImportLimits {
  /** Per-file timeout. */
  fileTimeoutMs: number;
  /** Per-file size, in characters of the decoded text. */
  fileMaxBytes: number;
  maxFiles: number;
  /** Nesting depth of `@import` (a link is depth 0, its imports depth 1). */
  maxDepth: number;
  totalMaxBytes: number;
  concurrency: number;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  fileTimeoutMs: 8_000,
  fileMaxBytes: 3_000_000,
  maxFiles: 100,
  maxDepth: 4,
  totalMaxBytes: 8_000_000,
  concurrency: 6,
};

// ---------------------------------------------------------------------------
// absolutize

// Matches whole string literals too, so a `url(` inside a string is skipped.
const URL_FN = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s][^)]*?))\s*\)/gi;

/** The absolute form of `u` against `base`, or null when it must stay as it
 * is (empty, `#fragment`, `data:`, already absolute, `var()`, unparseable). */
function absoluteUrl(u: string, base: string): string | null {
  const t = u.trim();
  if (!t || t.charAt(0) === "#" || /^data:/i.test(t) || /^[a-z][a-z0-9+.-]*:/i.test(t)) return null;
  if (t.indexOf("(") >= 0) return null;
  try {
    return new URL(t, base).href;
  } catch {
    return null;
  }
}

function quoteUrl(abs: string): string {
  return 'url("' + abs.replace(/"/g, "%22") + '")';
}

function rewriteUrls(value: string, base: string): string {
  if (value.toLowerCase().indexOf("url(") < 0) return value;
  return value.replace(URL_FN, (m: string, a?: string, b?: string, c?: string) => {
    if (m.charAt(0) === '"' || m.charAt(0) === "'") return m;
    const abs = absoluteUrl(a ?? b ?? c ?? "", base);
    return abs === null ? m : quoteUrl(abs);
  });
}

const IMPORT_HEAD = /^\s*(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s"']+))\s*\)|"([^"]*)"|'([^']*)')\s*([\s\S]*)$/i;

interface ParsedImport {
  url: string;
  rest: string;
}

function parseImportParams(params: string): ParsedImport | null {
  const m = IMPORT_HEAD.exec(params);
  if (!m) return null;
  const url = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "";
  return { url: url.trim(), rest: (m[6] ?? "").trim() };
}

function rewriteImportParams(params: string, base: string): string {
  const parsed = parseImportParams(params);
  if (!parsed || !parsed.url) return rewriteUrls(params, base);
  const abs = absoluteUrl(parsed.url, base);
  const url = abs ?? parsed.url;
  const rest = rewriteUrls(parsed.rest, base);
  return quoteUrl(url) + (rest ? " " + rest : "");
}

function absolutizeRoot(root: Root, baseUrl: string): void {
  root.walk((node) => {
    if (node.type === "decl") {
      const next = rewriteUrls(node.value, baseUrl);
      if (next !== node.value) node.value = next;
    } else if (node.type === "atrule") {
      const lower = node.name.toLowerCase();
      const next = lower === "import" ? rewriteImportParams(node.params, baseUrl) : rewriteUrls(node.params, baseUrl);
      if (next !== node.params) node.params = next;
    }
  });
}

/** Every `url(...)` and `@import` string in `text` made absolute against
 * `baseUrl` (`data:`, `#fragment` and absolute urls are left alone). Text that
 * postcss cannot parse is rewritten with plain regexes instead. */
export function absolutizeCss(text: string, baseUrl: string): string {
  let root: Root;
  try {
    root = parse(text);
  } catch {
    return rewriteUrls(
      text.replace(/@import\s+(?:"([^"]*)"|'([^']*)')/gi, (m: string, a?: string, b?: string) => {
        const abs = absoluteUrl(a ?? b ?? "", baseUrl);
        return abs === null ? m : "@import " + quoteUrl(abs);
      }),
      baseUrl,
    );
  }
  absolutizeRoot(root, baseUrl);
  return root.toString();
}

// ---------------------------------------------------------------------------
// imports

interface Wrapper {
  name: string;
  params: string;
}

function wrapNodes(nodes: ChildNode[], wrappers: Wrapper[]): ChildNode[] {
  let out = nodes;
  for (const w of wrappers) {
    const at = new AtRule({ name: w.name, params: w.params });
    at.append(...out);
    out = [at];
  }
  return out;
}

/** Splits the text after an `@import` url into `layer(...)`, `supports(...)`
 * and the media list, per the `@import` grammar (in that order). */
function parseImportConditions(rest: string): { layer: string | null; supports: string | null; media: string } {
  let s = rest.trim();
  let layer: string | null = null;
  let supports: string | null = null;
  const readParens = (from: number): number => {
    let depth = 0;
    for (let i = from; i < s.length; i++) {
      const ch = s.charAt(i);
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) return i;
      }
    }
    return s.length - 1;
  };
  for (;;) {
    if (layer === null && /^layer(?![\w-])/i.test(s)) {
      if (s.charAt(5) === "(") {
        const end = readParens(5);
        layer = s.slice(6, end).trim();
        s = s.slice(end + 1).trim();
      } else {
        layer = "";
        s = s.slice(5).trim();
      }
    } else if (supports === null && /^supports\(/i.test(s)) {
      const end = readParens(8);
      const inner = s.slice(9, end).trim();
      supports = /^(\(|not\s|[\w-]+\()/i.test(inner) ? inner : "(" + inner + ")";
      s = s.slice(end + 1).trim();
    } else {
      break;
    }
  }
  return { layer, supports, media: s };
}

function importWrappers(rest: string): Wrapper[] {
  const c = parseImportConditions(rest);
  const out: Wrapper[] = [];
  if (c.media) out.push({ name: "media", params: c.media });
  if (c.supports !== null) out.push({ name: "supports", params: c.supports });
  if (c.layer !== null) out.push({ name: "layer", params: c.layer });
  return out;
}

// ---------------------------------------------------------------------------
// SSRF guard: which stylesheet URLs the controller may ask a handle to fetch

/** True when `ip` is a literal IPv4/IPv6 address in a loopback, private,
 * link-local, CGNAT, unspecified, multicast, reserved or unique-local range
 * (IPv4-mapped / compatible / NAT64 / 6to4 IPv6 forms are judged by the IPv4
 * address they carry). False for anything else, including hostnames. */
export function isBlockedIp(ip: string): boolean {
  let a = ip.trim();
  if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1);
  const zone = a.indexOf("%");
  if (zone >= 0) a = a.slice(0, zone);
  const v4 = parseIpv4(a);
  if (v4) return blockedV4(v4);
  if (a.indexOf(":") >= 0) {
    const v6 = parseIpv6(a);
    return v6 ? blockedV6(v6) : true; // an address we cannot parse is not trusted
  }
  return false;
}

function parseIpv4(a: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return null;
  const parts = [m[1], m[2], m[3], m[4]].map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

function blockedV4(p: number[]): boolean {
  const [a, b, c] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function parseIpv6(a: string): number[] | null {
  let text = a;
  let tail: number[] = [];
  const dot = text.lastIndexOf(".");
  if (dot >= 0) {
    const colon = text.lastIndexOf(":");
    const v4 = parseIpv4(text.slice(colon + 1));
    if (!v4) return null;
    tail = v4;
    text = text.slice(0, colon + 1) + "0:0";
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (h: string): number[] | null => {
    if (h === "") return [];
    const out: number[] = [];
    for (const g of h.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  if (!head || !rest) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) bytes.push(g >> 8, g & 255);
  if (tail.length) {
    bytes[12] = tail[0];
    bytes[13] = tail[1];
    bytes[14] = tail[2];
    bytes[15] = tail[3];
  }
  return bytes;
}

function blockedV6(b: number[]): boolean {
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zeros(0, 15) && (b[15] === 0 || b[15] === 1)) return true; // :: and ::1
  if (b[0] === 0xff) return true; // multicast
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1] & 0xc0) >= 0x80) return true; // fe80::/10 link-local and fec0::/10 site-local
  const embedded = b.slice(12, 16);
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return true; // ::ffff:0:0/96 IPv4-mapped
  if (zeros(0, 8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) return true; // ::ffff:0:0:0/96 IPv4-translated
  if (zeros(0, 12)) return blockedV4(embedded); // ::a.b.c.d
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return true; // 2001::/32 Teredo
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (b[4] === 0 && b[5] === 1) return true; // 64:ff9b:1::/48 NAT64 local-use
    if (zeros(4, 12)) return blockedV4(embedded); // 64:ff9b::/96
  }
  if (b[0] === 0x20 && b[1] === 0x02) return blockedV4(b.slice(2, 6)); // 6to4
  return false;
}

/** Whether a stylesheet URL may be fetched on behalf of a page: http(s) only,
 * no credentials, no local or internal host names, no literal blocked IP. A
 * host name that RESOLVES to a blocked address is the fetcher's job to refuse
 * (see the Playwright adapter's DNS check). */
export function isFetchableStylesheetUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  let host = u.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  while (host.endsWith(".")) host = host.slice(0, -1);
  if (!host) return false;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal"
  ) {
    return false;
  }
  return !isBlockedIp(host);
}

// ---------------------------------------------------------------------------
// fetching

/** Remaining command time below which no new request is started. */
const MIN_REMAINING_TO_FETCH_MS = 8_000;
/** Pending requests are aborted this long before the command deadline. */
const ABORT_BEFORE_DEADLINE_MS = 3_000;

class Fetcher {
  private files = 0;
  private total = 0;
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly cache = new Map<string, Promise<string | null>>();

  constructor(
    private readonly fetchText: FetchText | undefined,
    private readonly lim: ImportLimits,
    private readonly deadlineAt: number,
    private readonly now: () => number,
  ) {}

  get(url: string): Promise<string | null> {
    if (!this.fetchText) return Promise.resolve(null);
    let p = this.cache.get(url);
    if (!p) {
      p = this.load(url);
      this.cache.set(url, p);
    }
    return p;
  }

  private async slot(): Promise<void> {
    if (this.active < this.lim.concurrency) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }

  private async load(url: string): Promise<string | null> {
    if (!isFetchableStylesheetUrl(url) || this.files >= this.lim.maxFiles) return null;
    this.files++;
    await this.slot();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const remaining = this.deadlineAt - this.now();
      if (remaining < MIN_REMAINING_TO_FETCH_MS) return null;
      const timeoutMs = Math.min(this.lim.fileTimeoutMs, remaining - ABORT_BEFORE_DEADLINE_MS);
      const controller = new AbortController();
      const res = await Promise.race([
        this.fetchText!(url, { timeoutMs, maxBytes: this.lim.fileMaxBytes, signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("timeout"));
          }, timeoutMs);
        }),
      ]);
      if (res.status < 200 || res.status >= 300) return null;
      if (typeof res.text !== "string" || res.text.length > this.lim.fileMaxBytes) return null;
      if (res.contentType && /text\/html/i.test(res.contentType)) return null;
      if (this.total + res.text.length > this.lim.totalMaxBytes) return null;
      this.total += res.text.length;
      return res.text;
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
      this.release();
    }
  }
}

function parseCss(text: string): Root | null {
  try {
    return parse(text);
  } catch {
    return null;
  }
}

/** One level of `@import` / wrapper conditions. */
interface Cond {
  media: string;
  supports: string | null;
  layer: string | null;
}

function hasTopLevelComma(q: string): boolean {
  let depth = 0;
  for (const ch of q) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) return true;
  }
  return false;
}

/** Several media queries as one (they must all hold), or null when that
 * cannot be written as a single query list. */
function combineMedia(all: string[]): string | null {
  const uniq = [...new Set(all.map((m) => m.trim()).filter(Boolean))];
  if (uniq.length <= 1) return uniq[0] ?? "";
  if (uniq.some((q) => hasTopLevelComma(q) || /^(not|only)\b/i.test(q))) return null;
  const typed = uniq.filter((q) => !q.startsWith("("));
  if (typed.length > 1) return null;
  return [...typed, ...uniq.filter((q) => q.startsWith("("))].join(" and ");
}

/** The parameters of an `@import` of `url` that applies every condition of
 * `conds` (outer to inner), or null when they cannot be expressed on an
 * `@import` (more than one layer or supports, or media that do not combine). */
function importParams(url: string, conds: Cond[]): string | null {
  let layer: string | null = null;
  let supports: string | null = null;
  for (const c of conds) {
    if (c.layer !== null) {
      if (layer !== null) return null;
      layer = c.layer;
    }
    if (c.supports !== null) {
      if (supports !== null) return null;
      supports = c.supports;
    }
  }
  const media = combineMedia(conds.map((c) => c.media));
  if (media === null) return null;
  let out = quoteUrl(url);
  if (layer !== null) out += layer === "" ? " layer" : " layer(" + layer + ")";
  if (supports !== null) out += " supports(" + supports + ")";
  if (media) out += " " + media;
  return out;
}

const mediaCond = (media: string): Cond => ({ media, supports: null, layer: null });

interface Expanded {
  root: Root;
  /** `@import` parameters of every import that could not be inlined, in
   * document order (this sheet's own and those of the sheets it inlined), each
   * with all the conditions it sat under. */
  fallbacks: string[];
  /** Fallbacks dropped because their conditions cannot be expressed on an `@import`. */
  dropped: number;
}

/** Parses `text`, absolutizes it against `baseUrl` and inlines every
 * top-level `@import` (recursively). `null` when postcss cannot parse it.
 * `conds` are the conditions the text itself sits under. */
async function expandText(
  text: string,
  baseUrl: string,
  depth: number,
  chain: string[],
  conds: Cond[],
  fetcher: Fetcher,
  lim: ImportLimits,
): Promise<Expanded | null> {
  const root = parseCss(text);
  if (!root) return null;
  absolutizeRoot(root, baseUrl);
  const imports = (root.nodes ?? []).filter((n): n is AtRule => n.type === "atrule" && n.name.toLowerCase() === "import");
  const perImport = await Promise.all(
    imports.map(async (node): Promise<{ fallbacks: string[]; dropped: number }> => {
      const none = { fallbacks: [], dropped: 0 };
      const parsed = parseImportParams(node.params);
      if (!parsed || !/^https?:/i.test(parsed.url)) return none; // data: or unreadable: hoisted later
      if (chain.includes(parsed.url)) {
        node.remove(); // cycle: the browser would ignore it too
        return none;
      }
      const own = parseImportConditions(parsed.rest);
      let sub: Expanded | null = null;
      if (depth + 1 <= lim.maxDepth) {
        const body = await fetcher.get(parsed.url);
        if (body !== null) sub = await expandText(body, parsed.url, depth + 1, [...chain, parsed.url], [...conds, own], fetcher, lim);
      }
      if (!sub) {
        node.remove();
        const params = importParams(parsed.url, [...conds, own]);
        return params === null ? { fallbacks: [], dropped: 1 } : { fallbacks: [params], dropped: 0 };
      }
      sub.root.walkAtRules("charset", (r) => {
        r.remove();
      });
      const nodes = wrapNodes([...(sub.root.nodes ?? [])], importWrappers(parsed.rest));
      node.replaceWith(...nodes);
      return { fallbacks: sub.fallbacks, dropped: sub.dropped };
    }),
  );
  return {
    root,
    fallbacks: perImport.flatMap((r) => r.fallbacks),
    dropped: perImport.reduce((n, r) => n + r.dropped, 0),
  };
}

function wrapText(text: string, media: string): string {
  return media && media !== "all" ? "@media " + media + "{" + text + "}" : text;
}

/** The conditions an at-rule block puts on what it contains, or null when it
 * cannot be written on an `@import`. */
function condOfParent(p: Container | undefined): Cond | null | "root" {
  if (!p || p.type === "root") return "root";
  if (p.type !== "atrule") return null;
  const at = p as AtRule;
  switch (at.name.toLowerCase()) {
    case "media":
      return mediaCond(at.params);
    case "supports":
      return { media: "", supports: at.params, layer: null };
    case "layer":
      return { media: "", supports: null, layer: at.params.trim() };
    default:
      return null;
  }
}

/** Moves every leftover `@charset` / `@import` (data: or unparseable ones) /
 * `@namespace` to the top of the sheet in the only valid order, outside every
 * wrapper block. A hoisted `@import` carries the wrapper conditions it sat
 * under (dropped when they cannot be expressed); `@namespace` stays unwrapped.
 * Returns how many imports were dropped. */
function hoistLeftovers(root: Root): number {
  const found: AtRule[] = [];
  root.walkAtRules((n) => {
    const name = n.name.toLowerCase();
    if (name === "charset" || name === "import" || name === "namespace") found.push(n);
  });
  if (found.length === 0) return 0;
  let charset: AtRule | null = null;
  const imports: AtRule[] = [];
  const namespaces: AtRule[] = [];
  let dropped = 0;
  for (const node of found) {
    const name = node.name.toLowerCase();
    const conds: Cond[] = [];
    let expressible = true;
    for (let p = node.parent as Container | undefined; p; p = p.parent as Container | undefined) {
      const c = condOfParent(p);
      if (c === "root") break;
      if (c === null) {
        expressible = false;
        break;
      }
      conds.unshift(c);
    }
    const topLevel = node.parent?.type === "root";
    node.remove();
    if (name === "charset") {
      if (topLevel && !charset) charset = node;
    } else if (name === "namespace") {
      namespaces.push(node);
    } else {
      const parsed = parseImportParams(node.params);
      let params: string | null;
      if (parsed) {
        const own = parseImportConditions(parsed.rest);
        params = expressible ? importParams(parsed.url, [...conds, own]) : null;
      } else {
        params = expressible && conds.length === 0 ? node.params : null;
      }
      if (params === null) dropped++;
      else imports.push(new AtRule({ name: "import", params }));
    }
  }
  root.prepend(...(charset ? [charset] : []), ...imports, ...namespaces);
  return dropped;
}

/** One source, finished. `root` is the parsed stylesheet (null when postcss
 * could not parse it: `text` is then the sheet as it came, absolutized);
 * `fallbacks` are `@import` statements, each meant for a `<style>` of its own
 * placed before the one for the sheet (a literal `@import` is only valid ahead
 * of every rule). `dropped` counts fallbacks omitted because their conditions
 * cannot be expressed (wrong styles are worse than missing ones). */
export interface ResolvedSheet {
  root: Root | null;
  text: string;
  fallbacks: string[];
  dropped: number;
}

/** The sheet's CSS text. */
export function sheetCss(sheet: ResolvedSheet): string {
  return sheet.root ? sheet.root.toString() : sheet.text;
}

/** An `@import` statement for a fallback's parameters. */
export function importStatement(params: string): string {
  return "@import " + params + ";";
}

export interface ResolveOptions {
  limits?: Partial<ImportLimits>;
  /** Command deadline (ms since epoch). Default: no deadline. */
  deadlineAt?: number;
  now?: () => number;
}

/** The v1 shape: a link becomes a fallback `@import`, an inline/adopted sheet
 * its absolutized text, nothing fetched or inlined. */
export function v1Shape(sources: CaptureSource[]): ResolvedSheet[] {
  return sources.map((src): ResolvedSheet => {
    const media = src.kind === "adopted" ? "" : src.media;
    const m = media && media !== "all" ? media : "";
    if (src.kind === "link") {
      const params = importParams(src.href, m ? [mediaCond(m)] : []);
      return { root: null, text: "", fallbacks: params === null ? [] : [params], dropped: params === null ? 1 : 0 };
    }
    return { root: null, text: wrapText(absolutizeCss(src.text, src.baseUrl), m), fallbacks: [], dropped: 0 };
  });
}

/** One finished sheet per source, in order: `link` files fetched, every
 * `@import` inlined, every url absolute, media/layer/supports turned into
 * wrapper blocks. A sheet that cannot be fetched (or any sheet when
 * `fetchText` is missing, or too little time is left) becomes a fallback
 * `@import url("<abs>")` that keeps its outer conditions. */
export async function resolveImports(
  sources: CaptureSource[],
  fetchText: FetchText | undefined,
  options: ResolveOptions = {},
): Promise<ResolvedSheet[]> {
  const lim = { ...DEFAULT_IMPORT_LIMITS, ...options.limits };
  const fetcher = new Fetcher(fetchText, lim, options.deadlineAt ?? Infinity, options.now ?? Date.now);
  return Promise.all(
    sources.map(async (src): Promise<ResolvedSheet> => {
      const media = src.kind === "adopted" ? "" : src.media;
      const m = media && media !== "all" ? media : "";
      const topConds = m ? [mediaCond(m)] : [];
      const wrappers: Wrapper[] = m ? [{ name: "media", params: m }] : [];
      let text: string;
      let baseUrl: string;
      let chain: string[] = [];
      const linkFallback = (): ResolvedSheet => {
        const params = importParams((src as { href: string }).href, topConds);
        return { root: null, text: "", fallbacks: params === null ? [] : [params], dropped: params === null ? 1 : 0 };
      };
      if (src.kind === "link") {
        const body = await fetcher.get(src.href);
        if (body === null) return linkFallback();
        text = body;
        baseUrl = src.href;
        chain = [src.href];
      } else {
        text = src.text;
        baseUrl = src.baseUrl;
      }
      const expanded = await expandText(text, baseUrl, 0, chain, topConds, fetcher, lim);
      if (!expanded) {
        if (src.kind === "link") return linkFallback();
        // unparseable: absolutize with the regex path rather than emit relative urls
        return { root: null, text: wrapText(absolutizeCss(text, baseUrl), m), fallbacks: [], dropped: 0 };
      }
      const { root } = expanded;
      const ownCharset = (root.nodes ?? []).find((n) => n.type === "atrule" && n.name.toLowerCase() === "charset");
      ownCharset?.remove();
      if (wrappers.length) root.append(...wrapNodes([...(root.nodes ?? [])], wrappers));
      const dropped = expanded.dropped + hoistLeftovers(root);
      if (ownCharset) root.prepend(ownCharset);
      return { root, text: "", fallbacks: expanded.fallbacks, dropped };
    }),
  );
}

// ---------------------------------------------------------------------------
// selectors: collect / apply

type SNode = selectorParser.Node;

const STRIP_PSEUDOS = new Set([
  ":hover",
  ":focus",
  ":focus-visible",
  ":focus-within",
  ":active",
  ":visited",
  ":link",
  ":target",
  ":before",
  ":after",
  ":first-line",
  ":first-letter",
]);

function isStripped(n: SNode): boolean {
  if (n.type !== "pseudo") return false;
  const v = (n as selectorParser.Pseudo).value.toLowerCase();
  return v.startsWith("::") || STRIP_PSEUDOS.has(v) || /^:-(webkit|moz|ms|o)-/.test(v);
}

interface SelAnalysis {
  /** The selector as written. */
  text: string;
  /** First compound (stripped) when it names `html` / `:root` ("root"), or
   * when it names no type at all and could match `<html>` ("classless"). */
  rootCompound: string | null;
  rootKind: "root" | "classless" | null;
  /** classless only: the existence test once `<html>` matched the compound
   * (null: no test, the selector is the compound alone). */
  matchedExistence: string | null;
  /** The selector with its first compound replaced by `:is(:root,:host)`. */
  rewritten: string | null;
  /** The "existence test" form, or null when the selector is kept untested. */
  existence: string | null;
}


function nodeText(n: SNode): string {
  return String(n).trim();
}

function combinatorText(n: SNode): string {
  const v = (n as selectorParser.Combinator).value.trim();
  return v ? " " + v + " " : " ";
}

function analyzeSelector(sel: selectorParser.Selector): SelAnalysis {
  const text = String(sel).trim();
  const keep: SelAnalysis = { text, rootCompound: null, rootKind: null, matchedExistence: null, rewritten: null, existence: null };
  const nodes: SNode[] = sel.nodes.filter((n) => n.type !== "comment");
  if (nodes.length === 0) return keep;

  let unsupported = false;
  let nestedStrip = false;
  sel.walk((n) => {
    if (n.type === "nesting") unsupported = true;
    else if (n.type === "pseudo") {
      const v = (n as selectorParser.Pseudo).value.toLowerCase();
      if (v === ":host" || v === ":host-context" || v === "::slotted") unsupported = true;
    }
  });
  if (unsupported) return keep;
  for (const n of nodes) {
    if (n.type === "pseudo" && (n as selectorParser.Pseudo).nodes.length) {
      (n as selectorParser.Pseudo).walk((inner) => {
        if (isStripped(inner)) nestedStrip = true;
      });
    }
  }

  const compounds: SNode[][] = [[]];
  const combs: SNode[] = [];
  for (const n of nodes) {
    if (n.type === "combinator") {
      combs.push(n);
      compounds.push([]);
    } else {
      compounds[compounds.length - 1].push(n);
    }
  }
  if (compounds[0].length === 0) return keep; // relative selector

  const compoundTexts = compounds.map((c) => c.filter((n) => !isStripped(n)).map(nodeText).join("") || "*");
  let existence = compoundTexts[0];
  for (let i = 0; i < combs.length; i++) existence += combinatorText(combs[i]) + compoundTexts[i + 1];

  const first = compounds[0];
  const isRoot = first.some(
    (n) =>
      !isStripped(n) &&
      ((n.type === "tag" && (n as selectorParser.Tag).value.toLowerCase() === "html") ||
        (n.type === "pseudo" && (n as selectorParser.Pseudo).value.toLowerCase() === ":root")),
  );
  let rootCompound: string | null = null;
  let rootKind: "root" | "classless" | null = null;
  let matchedExistence: string | null = null;
  let rewritten: string | null = null;
  const hasType = first.some((n) => !isStripped(n) && n.type === "tag");
  if (isRoot || (!hasType && compoundTexts[0] !== "*")) {
    rootCompound = compoundTexts[0];
    rootKind = isRoot ? "root" : "classless";
    const stripped = first.filter(isStripped).map(nodeText).join("");
    const rest = combs.length ? nodes.slice(nodes.indexOf(combs[0])).map((n) => n.toString()).join("").trimEnd() : "";
    // `:is()` takes the highest specificity of its arguments; `:where()` has
    // none and `C:not(*)` never matches but has C's: the rewritten compound
    // has exactly the specificity of the one it replaces (`:root[data-theme=dark]`
    // stays (0,2,0), `html` stays (0,0,1)). A classless C already carries its own.
    const replacement = isRoot
      ? ":is(:where(:root,:host)," + compoundTexts[0] + ":not(*))"
      : ":is(" + compoundTexts[0] + ",:where(:root,:host))";
    rewritten = replacement + stripped + rest;
    if (!isRoot && combs.length) {
      let tail = compoundTexts[1];
      for (let i = 1; i < combs.length; i++) tail += combinatorText(combs[i]) + compoundTexts[i + 1];
      const c = (combs[0] as selectorParser.Combinator).value.trim();
      matchedExistence = c === "" ? tail : c === ">" ? ":root > " + tail : existence;
    }
  }
  return { text, rootCompound, rootKind, matchedExistence, rewritten, existence: nestedStrip ? null : existence };
}

const analysisCache = new Map<string, SelAnalysis[] | null>();

function analyzeRule(selector: string): SelAnalysis[] | null {
  const hit = analysisCache.get(selector);
  if (hit !== undefined) return hit;
  let result: SelAnalysis[] | null;
  try {
    const ast = selectorParser().astSync(selector);
    result = ast.nodes.length ? ast.nodes.map(analyzeSelector) : null;
  } catch {
    result = null;
  }
  if (analysisCache.size > 50_000) analysisCache.clear();
  analysisCache.set(selector, result);
  return result;
}

/** At-rules whose block holds style rules that are pruned like top-level ones.
 * Rules anywhere else (@keyframes, @scope, nested inside a rule, ...) are not
 * style rules for this purpose and are never touched. */
const PRUNABLE_AT = new Set(["media", "supports", "layer", "container", "document", "-moz-document"]);

function isPrunableAt(n: ChildNode): n is AtRule {
  return n.type === "atrule" && !!n.nodes && PRUNABLE_AT.has(n.name.toLowerCase());
}

function forEachRule(container: Container, cb: (rule: Rule) => void): void {
  for (const node of [...(container.nodes ?? [])]) {
    if (node.type === "rule") cb(node);
    else if (isPrunableAt(node)) forEachRule(node, cb);
  }
}

export interface CssQueries {
  rootCompounds: string[];
  selectors: string[];
}

/** Everything the page has to answer before the sheets can be rewritten. */
export function collectQueries(roots: Root | Root[]): CssQueries {
  const rootCompounds = new Set<string>();
  const selectors = new Set<string>();
  for (const root of Array.isArray(roots) ? roots : [roots]) {
    forEachRule(root, (rule) => {
      const analysis = analyzeRule(rule.selector);
      if (!analysis) return;
      for (const a of analysis) {
        if (a.rootCompound !== null) rootCompounds.add(a.rootCompound);
        if (a.existence !== null) selectors.add(a.existence);
        if (a.matchedExistence !== null && a.existence !== null) selectors.add(a.matchedExistence);
      }
    });
  }
  return { rootCompounds: [...rootCompounds], selectors: [...selectors] };
}

function isEmpty(container: Container): boolean {
  return (container.nodes ?? []).every((n) => n.type === "comment");
}

function pruneContainer(
  container: Container,
  rootMatches: Set<string>,
  existing: Set<string>,
  unparseable: Set<string>,
): void {
  for (const node of [...(container.nodes ?? [])]) {
    if (node.type === "rule") {
      const analysis = analyzeRule(node.selector);
      if (!analysis) continue;
      const kept: string[] = [];
      let changed = false;
      for (const a of analysis) {
        let text = a.text;
        let tests: string[] | null = a.existence === null ? null : [a.existence];
        if (a.rootCompound !== null && !unparseable.has(a.rootCompound)) {
          if (a.rootKind === "root") {
            if (!rootMatches.has(a.rootCompound)) {
              changed = true;
              continue;
            }
            text = a.rewritten ?? a.text;
            changed = true;
            if (a.existence === a.rootCompound) tests = null; // root-only: element mode would find nothing
          } else if (rootMatches.has(a.rootCompound)) {
            // classless: <html> matches, so `C .x` there means `.x`
            text = a.rewritten ?? a.text;
            changed = true;
            // `C .x` on <html> means `.x`, but other elements matching C keep
            // the original meaning: keep on EITHER test.
            if (a.existence !== null) tests = a.matchedExistence === null ? null : [a.matchedExistence, a.existence];
          }
        }
        if (tests !== null && !tests.some((t) => existing.has(t) || unparseable.has(t))) {
          changed = true;
          continue;
        }
        kept.push(text);
      }
      if (kept.length === 0) node.remove();
      else if (changed) node.selector = kept.join(", ");
    } else if (isPrunableAt(node)) {
      pruneContainer(node, rootMatches, existing, unparseable);
      if (isEmpty(node)) {
        // An emptied named `@layer x {}` still fixes the layer order: keep it
        // as the statement `@layer x;`.
        const named = node.name.toLowerCase() === "layer" && node.params.trim() !== "";
        if (named) node.replaceWith(new AtRule({ name: "layer", params: node.params }));
        else node.remove();
      }
    }
  }
}

/** Rewrites `root` in place from the page's answers: a root compound that
 * matched becomes `:is(:root,:host)`, one that did not drops its selector;
 * selectors whose existence test found nothing are dropped (unless the page
 * could not parse them); rules and blocks left empty are dropped. */
export function applyQueryResults(
  root: Root,
  rootMatches: Set<string>,
  existing: Set<string>,
  unparseable: Set<string>,
): void {
  pruneContainer(root, rootMatches, existing, unparseable);
}

export function serialize(root: Root): string {
  return root.toString();
}

/** Parses a finished sheet body, or null when postcss cannot. */
export function parseSheet(text: string): Root | null {
  return parseCss(text);
}

/** `<style>` element text for CSS. Every `<` becomes the CSS escape `\3c `
 * (valid inside strings, `url()` and comments, and `<` is invalid CSS
 * anywhere else): `</style` can then never close the tag, and an HTML
 * sanitizer does not drop the element for an unencoded `<svg` inside a
 * `url("data:image/svg+xml,...")`, which it does for the raw text. */
export function renderStyleTag(css: string): string {
  return "<style>" + css.replace(/\\?</g, "\\3c ") + "</style>";
}
