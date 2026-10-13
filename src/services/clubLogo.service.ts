import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * General club-logo resolver: given a club name, resolve a hotlinkable crest
 * SVG from Wikimedia (Wikipedia infobox image → Commons/en imageinfo → verify).
 *
 * Used as the permanent fallback whenever a club has no local SVG under
 * public/assets/team_logos. Results are cached in json_store/club_logos.json so
 * each club is looked up online at most once (until its TTL lapses).
 */

const UA = { 'User-Agent': 'TanaBetting/1.0 (club-logo-resolver)' };
const FOUND_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days for a successful hit
const MISS_TTL = 24 * 60 * 60 * 1000; // 1 day for a miss (so new clubs get retried)

type CacheEntry = { url: string | null; at: number };
type CacheFile = Record<string, CacheEntry>;

let memCache: CacheFile | null = null;

function cachePath(): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'json_store', 'club_logos.json'),
    path.join(__dirname, '..', '..', '..', 'json_store', 'club_logos.json'),
    path.join(process.cwd(), 'json_store', 'club_logos.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  const primary = path.join(process.cwd(), 'json_store', 'club_logos.json');
  try {
    fs.mkdirSync(path.dirname(primary), { recursive: true });
  } catch {
    /* ignore */
  }
  return primary;
}

function loadCache(): CacheFile {
  if (memCache) return memCache;
  const f = cachePath();
  try {
    memCache = fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf-8')) as CacheFile) : {};
  } catch {
    memCache = {};
  }
  return memCache;
}

function saveCache() {
  if (!memCache) return;
  try {
    fs.writeFileSync(cachePath(), JSON.stringify(memCache, null, 2), 'utf-8');
  } catch {
    /* ignore write errors */
  }
}

/** Normalize a club name to a stable cache/URL key. */
export function normalizeClubKey(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function fetchJson(url: string, timeoutMs = 8000): Promise<unknown | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: UA, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function isSvg(url: string): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { method: 'HEAD', headers: UA, redirect: 'follow', signal: ctrl.signal });
    const ct = res.headers.get('content-type') ?? '';
    return res.ok && ct.includes('svg');
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** Resolve a Wikimedia File: title to a verified SVG upload URL (Commons then en). */
async function svgUrlForFile(fileTitle: string): Promise<string | null> {
  for (const api of ['https://commons.wikimedia.org', 'https://en.wikipedia.org']) {
    const q = (await fetchJson(
      `${api}/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url%7Csize%7Cmime&titles=${encodeURIComponent('File:' + fileTitle)}`
    )) as { query?: { pages?: Record<string, { imageinfo?: { url: string; mime: string; width: number; height: number }[] }> } } | null;
    const page = q?.query?.pages ? Object.values(q.query.pages)[0] : undefined;
    const info = page?.imageinfo?.[0];
    if (info && info.mime === 'image/svg+xml' && (info.width ?? 0) >= 40 && (info.height ?? 0) >= 40) {
      const clean = info.url.split('?')[0];
      if (await isSvg(clean)) return clean;
    }
  }
  // Fallback: derive the canonical upload URL from the file name (md5 path). Many
  // fair-use crests are served from /wikipedia/en/ even when imageinfo is flaky.
  const underscored = fileTitle.replace(/ /g, '_');
  const hash = crypto.createHash('md5').update(underscored).digest('hex');
  const direct = `https://upload.wikimedia.org/wikipedia/en/${hash[0]}/${hash.slice(0, 2)}/${underscored}`;
  if (await isSvg(direct)) return direct;
  return null;
}

/** Candidate crest file names to probe directly when API discovery is empty. */
function candidateFileNames(clubName: string): string[] {
  const base = clubName.replace(/\s+(FC|F\.C\.|AFC|CF|SC)$/i, '').trim().replace(/ /g, '_');
  return [
    `${base}_logo.svg`,
    `${base}_crest.svg`,
    `${base}_badge.svg`,
    `${base}_FC_logo.svg`,
    `${base}_FC_crest.svg`,
    `${base}_FC_badge.svg`,
    `${base}_AFC_crest.svg`,
    `${base}_AFC_logo.svg`,
    `${base}_F.C._logo.svg`,
    `${base}_F.C._crest.svg`,
    `${base}_football_club_logo.svg`,
  ];
}

/** Look up a club on Wikipedia and return a verified crest SVG URL (or null). */
async function lookupOnWikimedia(clubName: string): Promise<string | null> {
  const base = clubName.replace(/\s+(FC|F\.C\.|AFC|CF|SC)$/i, '').trim();
  const variants = Array.from(
    new Set([clubName, `${base} F.C.`, `${base} FC`, `${base} AFC`, base])
  );

  for (const title of variants) {
    // 1. Infobox page image
    const q = (await fetchJson(
      `https://en.wikipedia.org/w/api.php?action=query&format=json&prop=pageimages&titles=${encodeURIComponent(title)}&pithumbsize=120`
    )) as { query?: { pages?: Record<string, { missing?: unknown; pageimage?: string }> } } | null;
    const page = q?.query?.pages ? Object.values(q.query.pages)[0] : undefined;
    if (page && !page.missing && page.pageimage) {
      const url = await svgUrlForFile(page.pageimage);
      if (url) return url;
    }
  }

  // 2. Parse images and pick the crest/logo svg
  for (const title of variants) {
    const q = (await fetchJson(
      `https://en.wikipedia.org/w/api.php?action=parse&format=json&page=${encodeURIComponent(title)}&prop=images&redirects=1`
    )) as { parse?: { images?: string[] } } | null;
    const images = q?.parse?.images ?? [];
    const cands = images.filter((t) => /\.svg$/i.test(t) && /logo|crest|badge|emblem|shield/i.test(t) && !/Commons-logo/i.test(t));
    for (const cand of cands.slice(0, 4)) {
      const url = await svgUrlForFile(cand);
      if (url) return url;
    }
  }

  // 3. Probe common crest file names directly (md5 upload-path derivation)
  for (const fileTitle of candidateFileNames(clubName)) {
    const url = await svgUrlForFile(fileTitle);
    if (url) return url;
  }
  return null;
}

/**
 * Resolve a club logo URL. Returns the cached/online Wikimedia SVG URL, or null
 * when nothing suitable was found (caller should then show the generic logo).
 */
export async function resolveClubLogoOnline(clubName: string): Promise<string | null> {
  const key = normalizeClubKey(clubName);
  if (!key) return null;
  const cache = loadCache();
  const hit = cache[key];
  if (hit) {
    const ttl = hit.url ? FOUND_TTL : MISS_TTL;
    if (Date.now() - hit.at < ttl) return hit.url;
  }
  let url: string | null = null;
  try {
    url = await lookupOnWikimedia(clubName);
  } catch {
    url = null;
  }
  cache[key] = { url, at: Date.now() };
  saveCache();
  return url;
}