import "dotenv/config";
import prisma from "../src/utils/prisma";

// One-off: relate the clubs of each Big-5 league between The Odds API and
// football-data.org and persist the correct relation on the Team table.
// Idempotent: matches by footballDataTeamId first, then oddsApiName, then fullName.
//
// Run:  npx tsx prisma/link-league-teams.ts

const FD_TOKEN = (process.env.FOOTBALL_DATA_TOKEN ?? "").trim();
const ODDS_KEY = (process.env.API_ONE ?? "").trim();

type Pair = { odds: string; full: string };
type League = { code: string; sportKey: string; country: string; pairs: Record<number, Pair> };

const LEAGUES: League[] = [
  {
    code: "BL1",
    sportKey: "soccer_germany_bundesliga",
    country: "Germany",
    pairs: {
      1: { odds: "1. FC Köln", full: "1. FC Köln" },
      2: { odds: "TSG Hoffenheim", full: "TSG Hoffenheim" },
      3: { odds: "Bayer Leverkusen", full: "Bayer Leverkusen" },
      4: { odds: "Borussia Dortmund", full: "Borussia Dortmund" },
      5: { odds: "Bayern Munich", full: "Bayern Munich" },
      6: { odds: "FC Schalke 04", full: "FC Schalke 04" },
      7: { odds: "Hamburger SV", full: "Hamburger SV" },
      10: { odds: "VfB Stuttgart", full: "VfB Stuttgart" },
      12: { odds: "Werder Bremen", full: "Werder Bremen" },
      15: { odds: "FSV Mainz 05", full: "FSV Mainz 05" },
      16: { odds: "Augsburg", full: "Augsburg" },
      17: { odds: "SC Freiburg", full: "SC Freiburg" },
      18: { odds: "Borussia Monchengladbach", full: "Borussia Monchengladbach" },
      19: { odds: "Eintracht Frankfurt", full: "Eintracht Frankfurt" },
      28: { odds: "Union Berlin", full: "Union Berlin" },
      29: { odds: "SC Paderborn", full: "SC Paderborn" },
      719: { odds: "Elversberg", full: "Elversberg" },
      721: { odds: "RB Leipzig", full: "RB Leipzig" },
    },
  },
  {
    code: "SA",
    sportKey: "soccer_italy_serie_a",
    country: "Italy",
    pairs: {
      98: { odds: "AC Milan", full: "AC Milan" },
      99: { odds: "Fiorentina", full: "Fiorentina" },
      100: { odds: "AS Roma", full: "AS Roma" },
      102: { odds: "Atalanta BC", full: "Atalanta BC" },
      103: { odds: "Bologna", full: "Bologna" },
      104: { odds: "Cagliari", full: "Cagliari" },
      107: { odds: "Genoa", full: "Genoa" },
      108: { odds: "Inter Milan", full: "Inter Milan" },
      109: { odds: "Juventus", full: "Juventus" },
      110: { odds: "Lazio", full: "Lazio" },
      112: { odds: "Parma", full: "Parma" },
      113: { odds: "Napoli", full: "Napoli" },
      115: { odds: "Udinese", full: "Udinese" },
      454: { odds: "Venezia", full: "Venezia" },
      470: { odds: "Frosinone", full: "Frosinone" },
      471: { odds: "Sassuolo", full: "Sassuolo" },
      586: { odds: "Torino", full: "Torino" },
      5890: { odds: "Lecce", full: "Lecce" },
      5911: { odds: "Monza", full: "Monza" },
      7397: { odds: "Como", full: "Como" },
    },
  },
  {
    code: "PD",
    sportKey: "soccer_spain_la_liga",
    country: "Spain",
    pairs: {
      77: { odds: "Athletic Bilbao", full: "Athletic Bilbao" },
      78: { odds: "Atlético Madrid", full: "Atlético Madrid" },
      79: { odds: "CA Osasuna", full: "CA Osasuna" },
      80: { odds: "Espanyol", full: "Espanyol" },
      81: { odds: "Barcelona", full: "Barcelona" },
      82: { odds: "Getafe", full: "Getafe" },
      84: { odds: "Málaga", full: "Málaga" },
      86: { odds: "Real Madrid", full: "Real Madrid" },
      87: { odds: "Rayo Vallecano", full: "Rayo Vallecano" },
      88: { odds: "Levante", full: "Levante" },
      90: { odds: "Real Betis", full: "Real Betis" },
      92: { odds: "Real Sociedad", full: "Real Sociedad" },
      94: { odds: "Villarreal", full: "Villarreal" },
      95: { odds: "Valencia", full: "Valencia" },
      263: { odds: "Alavés", full: "Alavés" },
      285: { odds: "Elche CF", full: "Elche CF" },
      558: { odds: "Celta Vigo", full: "Celta Vigo" },
      559: { odds: "Sevilla", full: "Sevilla" },
      560: { odds: "Deportivo La Coruña", full: "Deportivo La Coruña" },
      5335: { odds: "Real Racing Club de Santander", full: "Real Racing Club de Santander" },
    },
  },
];

type FdTeam = { id: number; name: string; shortName?: string | null; crest?: string | null };
type OddsEvent = { home_team: string; away_team: string };

const TRANSIENT = ["Server has closed", "max_statement_time", "Can't reach", "Timed out", "connection"];
async function withRetry<T>(fn: () => Promise<T>, tries = 6, waitMs = 5000): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (TRANSIENT.some((s) => msg.includes(s))) {
        console.log(`  (db busy, retry ${i + 1}/${tries})`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw e;
    }
  }
  throw last;
}

async function fetchFdTeams(code: string): Promise<FdTeam[]> {
  const res = await fetch(`https://api.football-data.org/v4/competitions/${code}/teams`, { headers: { "X-Auth-Token": FD_TOKEN } });
  if (!res.ok) throw new Error(`football-data ${code}: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const data = (await res.json()) as { teams?: FdTeam[] };
  if (!Array.isArray(data.teams)) throw new Error(`football-data ${code}: invalid payload`);
  return data.teams;
}

async function fetchOddsNames(sportKey: string): Promise<Set<string>> {
  const res = await fetch(`https://api.the-odds-api.com/v4/sports/${sportKey}/events/?apiKey=${ODDS_KEY}`);
  if (!res.ok) throw new Error(`odds-api ${sportKey}: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const events = (await res.json()) as OddsEvent[];
  if (!Array.isArray(events)) throw new Error(`odds-api ${sportKey}: invalid payload`);
  const names = new Set<string>();
  for (const e of events) {
    if (typeof e.home_team === "string") names.add(e.home_team);
    if (typeof e.away_team === "string") names.add(e.away_team);
  }
  return names;
}

async function main() {
  if (!FD_TOKEN) throw new Error("FOOTBALL_DATA_TOKEN missing");
  if (!ODDS_KEY) throw new Error("API_ONE missing");
  await withRetry(() => prisma.team.count());

  let created = 0;
  let updated = 0;
  const problems: string[] = [];

  for (const lg of LEAGUES) {
    const [fdTeams, oddsNames] = await Promise.all([fetchFdTeams(lg.code), fetchOddsNames(lg.sportKey)]);
    console.log(`\n=== ${lg.code} (${lg.country}) — football-data ${fdTeams.length} teams, odds-api ${oddsNames.size} names ===`);
    if (oddsNames.size === 0) console.log("  (no upcoming fixtures; saving mappings without live verification)");

    for (const fd of fdTeams) {
      const pair = lg.pairs[fd.id];
      if (!pair) {
        problems.push(`${lg.code} fd ${fd.id} ${fd.name}: no odds-api name mapped — skipped`);
        continue;
      }
      if (oddsNames.size > 0 && !oddsNames.has(pair.odds)) {
        problems.push(`${lg.code} fd ${fd.id} ${fd.name}: odds name "${pair.odds}" not seen in live events (still saved)`);
      }

      const data = {
        fullName: pair.full,
        shortName: fd.shortName?.trim() || pair.full,
        oddsApiName: pair.odds,
        footballDataName: fd.name,
        footballDataTeamId: fd.id,
        iconUrl: fd.crest ?? `https://crests.football-data.org/${fd.id}.png`,
        country: lg.country,
        isNational: false,
      };

      const byFd = await withRetry(() => prisma.team.findFirst({ where: { footballDataTeamId: fd.id }, select: { id: true, fullName: true } }));
      const byOdds = byFd ? null : await withRetry(() => prisma.team.findFirst({ where: { oddsApiName: pair.odds }, select: { id: true, fullName: true } }));
      const byName = byFd || byOdds ? null : await withRetry(() => prisma.team.findFirst({ where: { fullName: pair.full }, select: { id: true, fullName: true } }));

      if (byFd) {
        await withRetry(() => prisma.team.update({ where: { id: byFd.id }, data: { ...data, fullName: byFd.fullName } }));
        updated++;
        console.log(`  upd ${fd.id} | ${byFd.fullName} | odds="${pair.odds}" | fd="${fd.name}"`);
      } else if (byOdds) {
        await withRetry(() => prisma.team.update({ where: { id: byOdds.id }, data: { ...data, fullName: byOdds.fullName } }));
        updated++;
        console.log(`  upd ${fd.id} | ${byOdds.fullName} | odds="${pair.odds}" | fd="${fd.name}"`);
      } else if (byName) {
        await withRetry(() => prisma.team.update({ where: { id: byName.id }, data }));
        updated++;
        console.log(`  upd ${fd.id} | ${byName.fullName} | odds="${pair.odds}" | fd="${fd.name}"`);
      } else {
        await withRetry(() => prisma.team.create({ data }));
        created++;
        console.log(`  new ${fd.id} | ${pair.full} | odds="${pair.odds}" | fd="${fd.name}"`);
      }
    }
  }

  console.log(`\nDone: ${created} created, ${updated} updated.`);
  if (problems.length) {
    console.log(`\nNotes (${problems.length}):`);
    for (const p of problems) console.log(`  - ${p}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());