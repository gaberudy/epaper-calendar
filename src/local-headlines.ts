import { XMLParser } from "fast-xml-parser";

type FetchOpts = {
  url?: string;                 // default below
  maxItems?: number;            // cap results (default 5)
  timeoutMs?: number;           // fetch timeout (default 4000)
  excludeTowns?: string[];      // override the default town list
};

const DEFAULT_URL_PRIMARY = process.env.HEADLINES_URL || "https://www.kbzk.com/news.rss";
const DEFAULT_URL_FALLBACK = process.env.HEADLINES_FALLBACK_URL || "https://www.kbzk.com/news/rss"; // observed alt path
const DEFAULT_EXCLUDES: string[] = [];

export async function fetchKBZKLocalHeadlines(opts: FetchOpts = {}): Promise<string[]> {
  const url = opts.url ?? DEFAULT_URL_PRIMARY;
  const timeoutMs = opts.timeoutMs ?? 4000;
  const maxItems = opts.maxItems ?? 5;
  const excludes = (opts.excludeTowns ?? DEFAULT_EXCLUDES)
    .map(s => s.trim())
    .filter(Boolean);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  let xml: string;
  try {
    const res = await fetch(url, { signal: controller.signal, headers: {
      "Accept": "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1",
      "User-Agent": "epaper-board/1.0 (+local)"
    }});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    xml = await res.text();
  } catch (e) {
    // try the fallback path once
    if (url !== DEFAULT_URL_FALLBACK) {
      clearTimeout(t);
      return fetchKBZKLocalHeadlines({ ...opts, url: DEFAULT_URL_FALLBACK });
    }
    clearTimeout(t);
    throw e;
  }
  clearTimeout(t);

  // Parse XML -> JS
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    trimValues: true
  });
  const doc = parser.parse(xml);

  // RSS shape: rss.channel.item[] with title/link fields
  const items: any[] = normalizeItems(doc);

  // Keep only /local-news/ links
  const onlyLocal = items.filter(it => {
    const link: string = String((it.link ?? "").toString());
    return link.includes("/local-news/");
  });

  // Exclude town names in the title (case-insensitive)
  const re = new RegExp(`\\b(${excludes.map(escapeRegex).join("|")})\\b`, "i");
  const filtered = onlyLocal.filter(it => !re.test(String(it.title ?? "")));

  // Clean titles, dedupe by title text, cap
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const it of filtered) {
    const raw = String(it.title ?? "").trim();
    if (!raw) continue;
    if (seen.has(raw.toLowerCase())) continue;
    seen.add(raw.toLowerCase());
    titles.push(deentitize(raw));
    if (titles.length >= maxItems) break;
  }
  return titles;
}

/* ----------------- helpers ----------------- */

function normalizeItems(doc: any): any[] {
  // try common shapes safely
  const ch = doc?.rss?.channel ?? doc?.feed ?? doc?.channel;
  if (!ch) return [];
  const items = ch.item ?? ch.items ?? [];
  return Array.isArray(items) ? items : [items].filter(Boolean);
}

// extremely small HTML entity decode for common cases
function deentitize(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/gi, " ")
    .trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
