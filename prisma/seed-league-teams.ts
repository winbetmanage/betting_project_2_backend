import "dotenv/config";
import prisma from "../src/utils/prisma";
import {
  getLaLigaEventsUrl,
  getBundesligaEventsUrl,
  getSerieAEventsUrl,
  getLigue1EventsUrl,
  getLaLigaTeamsUrl,
  getBundesligaTeamsUrl,
  getSerieATeamsUrl,
  getLigue1TeamsUrl,
  footballDataFetchOptions,
} from "../codes";

// ============================================================================
// One-off seed: all teams of La Liga, Bundesliga, Serie A and Ligue 1.
// Fetches BOTH APIs per league and relates their names:
//   - football-data /competitions/{code}/teams  -> id, name, shortName, crest
//   - The Odds API {league}/events               -> home_team / away_team names
// Confident matches (exact or full token-subset) are linked via oddsApiName.
// Ambiguous / unmatched names are HELD BACK and reported — never guessed.
// If a league's football-data endpoint fails, that league is SKIPPED
// entirely (no odds-only rows) and reported.
// Run:  npm run db:seed:leagues
// ============================================================================

type League = {
  key: string;
  label: string;
  country: string;
  eventsUrl: () => string;
  teamsUrl: () => string;
};

const LEAGUES: League[] = [
  { key: "la-liga", label: "La Liga", country: "Spain", eventsUrl: getLaLigaEventsUrl, teamsUrl: getLaLigaTeamsUrl },
  { key: "bundesliga", label: "Bundesliga", country: "Germany", eventsUrl: getBundesligaEventsUrl, teamsUrl: getBundesligaTeamsUrl },
  { key: "serie-a", label: "Serie A", country: "Italy", eventsUrl: getSerieAEventsUrl, teamsUrl: getSerieATeamsUrl },
  { key: "ligue-1", label: "Ligue 1", country: "France", eventsUrl: getLigue1EventsUrl, teamsUrl: getLigue1TeamsUrl },
];

type FdTeam = { id: number; name: string; shortName?: string | null; tla?: string | null; crest?: string | null };
type OddsEvent = { id: string; home_team: string; away_team: string };

// --- name matching (same normalization as the settlement engine) ---
const EXPANSIONS: Record<string, string> = {
  man: "manchester",
  utd: "united",
  nottm: "nottingham",
  wolves: "wolverhampton",
  st: "saint",
  saints: "saint",
};
// city / club-name aliases, always folded toward the football-data spelling
const ALIASES: Record<string, string> = {
  milan: "milano",
  munich: "munchen",
  inter: "internazionale",
  lyonnais: "lyon",
  rennais: "rennes",
  brestois: "brest",
};
const NOISE = new Set([
  "fc", "afc", "acf", "cfc", "cf", "sc", "fk", "sk", "bc", "ac", "ss", "ssc",
  "as", "rc", "rcd", "scf", "fsv", "vfb", "sv", "us", "es", "aj", "ogc", "osc",
  "sco", "ud", "sd", "ca", "club",
  "de", "du", "des", "la", "le", "les", "di", "del", "della", "dos", "das",
  "der", "von", "van", "al", "el", "los", "las", "the",
]);

const FOLD: Record<string, string> = {
  à: "a", á: "a", â: "a", ã: "a", ä: "a", å: "a",
  è: "e", é: "e", ê: "e", ë: "e",
  ì: "i", í: "i", î: "i", ï: "i",
  ò: "o", ó: "o", ô: "o", õ: "o", ö: "o",
  ù: "u", ú: "u", û: "u", ü: "u",
  ñ: "n", ç: "c", ß: "ss", æ: "ae", œ: "oe",
};

function foldDiacritics(s: string): string {
  return s
    .toLowerCase()
    .split("")
    .map((c) => FOLD[c] ?? c)
    .join("");
}

function tokens(s: string): Set<string> {
  return new Set(
    foldDiacritics(s)
      .replace(/[^a-z0-9 ]/g, " ")
      .split(" ")
      .filter(Boolean)
      .map((t) => (/^\d+$/.test(t) ? "" : t)) // founding years / numbers never identify a club
      .filter(Boolean)
      .map((t) => EXPANSIONS[t] ?? t)
      .map((t) => ALIASES[t] ?? t)
      .filter((t) => !NOISE.has(t))
  );
}

function normStr(s: string): string {
  return [...tokens(s)].sort().join(" ");
}

type Verdict = "confident" | "ambiguous" | "none";

function judge(oddsName: string, fdName: string, uniqueSingle?: (tok: string) => boolean): Verdict {
  const a = normStr(oddsName);
  const b = normStr(fdName);
  if (a !== "" && a === b) return "confident";
  const A = tokens(oddsName);
  const B = tokens(fdName);
  if (A.size === 0 || B.size === 0) return "none";
  const [small, large] = A.size <= B.size ? [A, B] : [B, A];
  const subset = [...small].every((t) => large.has(t));
  if (subset && (A.size === B.size || small.size >= 2)) return "confident";
  // a single distinctive token (e.g. "athletic", "marseille") is confident only
  // when it is unique across BOTH name lists in the league — generic words like
  // "united" or "city" can never pass this gate.
  if (subset && small.size === 1 && uniqueSingle) {
    const tok = [...small][0];
    if (tok.length >= 4 && uniqueSingle(tok)) return "confident";
  }
  const shared = [...A].filter((t) => B.has(t)).length;
  return shared > 0 ? "ambiguous" : "none";
}

// "Arsenal FC" -> "Arsenal"; falls back to the raw name when nothing strips.
function cleanName(fd: FdTeam): string {
  if (fd.shortName && fd.shortName.trim()) return fd.shortName.trim();
  const n = fd.name
    .trim()
    .replace(/^(FC|AFC|FK|SK|RB|AC|SSC|AS|RC|CA|UD|SD)\s+/i, "")
    .replace(/\s+(FC|AFC|CF|BC|SC|SK|FK|AC|1907)$/i, "")
    .trim();
  return n || fd.name.trim();
}

const TRANSIENT = ["Server has closed", "max_statement_time", "Can't reach"];

async function withRetry<T>(fn: () => Promise<T>, tries = 5, waitMs = 4000): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (TRANSIENT.some((s) => msg.includes(s))) {
        console.log(`  (db busy, retry ${i + 1}/${tries})`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} for ${url} — ${text.slice(0, 200)}`);
  }
  return res.json();
}

type Report = {
  league: string;
  country: string;
  fdTeams: FdTeam[];
  links: Map<number, string>;
  linked: string[];
  fdOnly: string[];
  ambiguous: string[];
  oddsUnmatched: string[];
  skipped: boolean;
  error?: string;
};

async function relateLeague(lg: League): Promise<Report> {
  const rep: Report = {
    league: lg.label,
    country: lg.country,
    fdTeams: [],
    links: new Map(),
    linked: [],
    fdOnly: [],
    ambiguous: [],
    oddsUnmatched: [],
    skipped: false,
  };
  console.log(`\n=== ${lg.label} ===`);

  // 1. football-data teams (fail -> skip whole league)
  let fdTeams: FdTeam[];
  try {
    const data = (await fetchJson(lg.teamsUrl(), footballDataFetchOptions().headers)) as { teams?: FdTeam[] };
    if (!Array.isArray(data.teams) || data.teams.length === 0) throw new Error("empty teams list");
    fdTeams = data.teams;
  } catch (e) {
    rep.skipped = true;
    rep.error = `football-data teams fetch failed: ${e instanceof Error ? e.message : String(e)}`;
    console.error(`  SKIPPED: ${rep.error}`);
    return rep;
  }

  // 2. Odds API event team names (fail -> skip whole league, names can't be related)
  let oddsNames: string[];
  try {
    if (lg.eventsUrl().includes("apiKey=undefined")) throw new Error("API key not configured (API_ONE)");
    const events = (await fetchJson(lg.eventsUrl())) as OddsEvent[];
    if (!Array.isArray(events)) throw new Error("invalid events payload");
    oddsNames = Array.from(new Set(events.flatMap((e) => [e.home_team, e.away_team]).filter((n) => typeof n === "string" && n.trim())));
  } catch (e) {
    rep.skipped = true;
    rep.error = `Odds API events fetch failed: ${e instanceof Error ? e.message : String(e)}`;
    console.error(`  SKIPPED: ${rep.error}`);
    return rep;
  }

  rep.fdTeams = fdTeams;
  console.log(`  FD teams: ${fdTeams.length}, Odds names: ${oddsNames.length}`);

  // 3. relate names (1:1, confident only — the rest is reported, never guessed)
  const countIn = (names: string[]) => {
    const freq = new Map<string, number>();
    for (const n of names) for (const t of tokens(n)) freq.set(t, (freq.get(t) ?? 0) + 1);
    return freq;
  };
  const fdFreq = countIn(fdTeams.map((f) => f.name));
  const oddsFreq = countIn(oddsNames);
  const uniqueSingle = (tok: string) => (fdFreq.get(tok) ?? 0) === 1 && (oddsFreq.get(tok) ?? 0) === 1;
  const usedOdds = new Set<string>();
  for (const fd of fdTeams) {
    let best: string | null = null;
    let bestConfident = false;
    let confidentCount = 0;
    for (const on of oddsNames) {
      if (usedOdds.has(on)) continue;
      const v = judge(on, fd.name, uniqueSingle);
      if (v === "confident") {
        confidentCount++;
        if (!bestConfident) {
          best = on;
          bestConfident = true;
        }
      } else if (v === "ambiguous" && !bestConfident && !best) {
        best = on;
      }
    }
    if (bestConfident && confidentCount === 1 && best) {
      rep.links.set(fd.id, best);
      usedOdds.add(best);
      rep.linked.push(`"${cleanName(fd)}" <-> "${best}" (fd ${fd.id})`);
    } else if (best) {
      rep.ambiguous.push(`"${best}" ~ "${fd.name}" (fd ${fd.id})${confidentCount > 1 ? " — multiple confident candidates" : " — only a partial overlap"}`);
      rep.fdOnly.push(`"${fd.name}" (fd ${fd.id}) — stored FD-only`);
    } else {
      rep.fdOnly.push(`"${fd.name}" (fd ${fd.id}) — no Odds API counterpart, stored FD-only`);
    }
  }
  for (const on of oddsNames) {
    if (!usedOdds.has(on)) rep.oddsUnmatched.push(`"${on}" — no confident FD match (auto-created at staging)`);
  }

  console.log(`  linked: ${rep.linked.length}, fd-only: ${rep.fdOnly.length}, ambiguous: ${rep.ambiguous.length}, odds unmatched: ${rep.oddsUnmatched.length}`);
  return rep;
}

async function writeLeague(rep: Report): Promise<void> {
  for (const fd of rep.fdTeams) {
    const oddsName = rep.links.get(fd.id) ?? null;
    const display = cleanName(fd);
    const short = fd.shortName?.trim() || display;
    try {
      await withRetry(async () => {
        // never steal another row's unique oddsApiName slot
        let finalOdds: string | null = oddsName;
        if (finalOdds) {
          const clash = await prisma.team.findFirst({
            where: { oddsApiName: finalOdds, NOT: { footballDataTeamId: fd.id } },
            select: { id: true, fullName: true },
          });
          if (clash) {
            rep.ambiguous.push(`"${finalOdds}" confidently matches "${fd.name}" but is already linked to "${clash.fullName}" — held back`);
            finalOdds = null;
            rep.links.delete(fd.id);
            rep.linked.splice(
              rep.linked.findIndex((s) => s.includes(`fd ${fd.id}`)),
              1
            );
            rep.fdOnly.push(`"${fd.name}" (fd ${fd.id}) — stored FD-only (link clashed, see held-back)`);
          }
        }
        const data = {
          fullName: display,
          shortName: short,
          ...(finalOdds ? { oddsApiName: finalOdds } : {}),
          footballDataName: fd.name,
          footballDataTeamId: fd.id,
          iconUrl: fd.crest ?? null,
          country: rep.country,
          isNational: false,
        };
        const byFdId = await prisma.team.findFirst({ where: { footballDataTeamId: fd.id }, select: { id: true } });
        if (byFdId) {
          await prisma.team.update({ where: { id: byFdId.id }, data });
          return;
        }
        if (finalOdds) {
          const byOdds = await prisma.team.findFirst({ where: { oddsApiName: finalOdds }, select: { id: true } });
          if (byOdds) {
            await prisma.team.update({ where: { id: byOdds.id }, data });
            return;
          }
        }
        await prisma.team.create({ data });
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      rep.ambiguous.push(`"${fd.name}" (fd ${fd.id}) — DB error, held back: ${msg}`);
      console.error(`  FAILED ${fd.name}: ${msg}`);
    }
  }
}

async function checkDatabase(): Promise<void> {
  try {
    await prisma.team.count();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`database unreachable — start it and re-run (nothing was written): ${msg.split("\n")[0]}`);
  }
}

function printReport(reports: Report[]): boolean {
  console.log("\n==================== REPORT ====================");
  let failed = false;
  for (const r of reports) {
    console.log(`\n-- ${r.league}${r.skipped ? " [SKIPPED]" : ""} (FD: ${r.fdTeams.length})`);
    if (r.error) {
      console.log(`   ERROR: ${r.error}`);
      failed = true;
    }
    if (r.linked.length) {
      console.log(`   LINKED (${r.linked.length}):`);
      for (const s of r.linked) console.log(`     + ${s}`);
    }
    const heldBack = [...r.fdOnly, ...r.ambiguous, ...r.oddsUnmatched];
    if (heldBack.length) {
      console.log(`   HELD BACK (${heldBack.length}):`);
      for (const s of heldBack) console.log(`     - ${s}`);
    }
  }
  return failed;
}

async function main() {
  // phase 1: fetch + relate (APIs only, no writes)
  const reports: Report[] = [];
  for (const lg of LEAGUES) reports.push(await relateLeague(lg));
  const apiFailed = printReport(reports);

  // phase 2: single fast DB check, then write
  try {
    await checkDatabase();
  } catch (e) {
    console.error(`\n${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }
  for (const r of reports) {
    if (!r.skipped) await writeLeague(r);
  }

  console.log("\n==================== AFTER WRITE ====================");
  printReport(reports);
  const total = await withRetry(() => prisma.team.count());
  console.log(`\nteams in table: ${total}`);
  if (apiFailed) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
