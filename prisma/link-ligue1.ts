import "dotenv/config";
import prisma from "../src/utils/prisma";

// One-off: relate France Ligue 1 clubs between The Odds API and football-data.org
// and persist the correct relation on the Team table. Idempotent: matches by
// footballDataTeamId first, then oddsApiName, then fullName.
//
// Run:  npx tsx prisma/link-ligue1.ts

const FD_TOKEN = (process.env.FOOTBALL_DATA_TOKEN ?? "").trim();
const ODDS_KEY = (process.env.API_ONE ?? "").trim();

// fd id -> { odds: name used by The Odds API, full: display name if a new row is created }
const PAIRS: Record<number, { odds: string; full: string }> = {
  511: { odds: "Toulouse", full: "Toulouse" },
  512: { odds: "Brest", full: "Brest" },
  516: { odds: "Marseille", full: "Marseille" },
  519: { odds: "Auxerre", full: "Auxerre" },
  521: { odds: "Lille", full: "Lille" },
  522: { odds: "Nice", full: "OGC Nice" },
  523: { odds: "Lyon", full: "Olympique Lyonnais" },
  524: { odds: "Paris Saint Germain", full: "Paris Saint-Germain" },
  525: { odds: "Lorient", full: "Lorient" },
  529: { odds: "Rennes", full: "Stade Rennais" },
  531: { odds: "Troyes", full: "Troyes" },
  532: { odds: "Angers", full: "Angers" },
  533: { odds: "Le Havre", full: "Le Havre" },
  535: { odds: "Le Mans FC", full: "Le Mans FC" },
  546: { odds: "RC Lens", full: "RC Lens" },
  548: { odds: "AS Monaco", full: "AS Monaco" },
  576: { odds: "Strasbourg", full: "Strasbourg" },
  1045: { odds: "Paris FC", full: "Paris FC" },
};

type FdTeam = { id: number; name: string; shortName?: string | null; crest?: string | null };
type OddsEvent = { home_team: string; away_team: string };

const TRANSIENT = ["Server has closed", "max_statement_time", "Can't reach", "Timed out", "connection"];

async function withRetry<T>(fn: () => Promise<T>, tries = 6, waitMs = 5000): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (TRANSIENT.some((s) => msg.includes(s))) {
        console.log(`  (db busy, retry ${i + 1}/${tries} in ${waitMs}ms)`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function fetchFdTeams(): Promise<FdTeam[]> {
  const res = await fetch("https://api.football-data.org/v4/competitions/FL1/teams", {
    headers: { "X-Auth-Token": FD_TOKEN },
  });
  if (!res.ok) throw new Error(`football-data FL1 teams: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const data = (await res.json()) as { teams?: FdTeam[] };
  if (!Array.isArray(data.teams)) throw new Error("football-data: invalid teams payload");
  return data.teams;
}

async function fetchOddsNames(): Promise<Set<string>> {
  const res = await fetch(`https://api.the-odds-api.com/v4/sports/soccer_france_ligue_one/events/?apiKey=${ODDS_KEY}`);
  if (!res.ok) throw new Error(`odds-api FL1 events: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const events = (await res.json()) as OddsEvent[];
  if (!Array.isArray(events)) throw new Error("odds-api: invalid events payload");
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

  // Pre-flight DB check with retries (the remote server is sometimes flaky).
  await withRetry(() => prisma.team.count());

  const [fdTeams, oddsNames] = await Promise.all([fetchFdTeams(), fetchOddsNames()]);
  console.log(`football-data FL1 teams: ${fdTeams.length} · odds-api club names: ${oddsNames.size}\n`);

  if (oddsNames.size === 0) {
    console.log("Odds API returned no upcoming Ligue 1 events — cannot verify odds names right now.");
    console.log("(Names are verified only when the league has fixtures. Re-run during the season.)");
  }

  let created = 0;
  let updated = 0;
  const problems: string[] = [];

  for (const fd of fdTeams) {
    const pair = PAIRS[fd.id];
    if (!pair) {
      problems.push(`fd ${fd.id} ${fd.name}: no odds-api name mapped — skipped`);
      continue;
    }
    const oddsVerified = oddsNames.size === 0 || oddsNames.has(pair.odds);
    if (!oddsVerified) problems.push(`fd ${fd.id} ${fd.name}: odds name "${pair.odds}" not seen in live events (still saving)`);

    const data = {
      fullName: pair.full,
      shortName: fd.shortName?.trim() || pair.full,
      oddsApiName: pair.odds,
      footballDataName: fd.name,
      footballDataTeamId: fd.id,
      iconUrl: fd.crest ?? `https://crests.football-data.org/${fd.id}.png`,
      country: "France",
      isNational: false,
    };

    const byFd = await withRetry(() => prisma.team.findFirst({ where: { footballDataTeamId: fd.id }, select: { id: true, fullName: true } }));
    const byOdds = byFd ? null : await withRetry(() => prisma.team.findFirst({ where: { oddsApiName: pair.odds }, select: { id: true, fullName: true } }));
    const byName = byFd || byOdds ? null : await withRetry(() => prisma.team.findFirst({ where: { fullName: pair.full }, select: { id: true, fullName: true } }));

    if (byFd) {
      // Relation update only — keep the existing display name.
      await withRetry(() => prisma.team.update({ where: { id: byFd.id }, data: { ...data, fullName: byFd.fullName } }));
      updated++;
      console.log(`upd  ${fd.id} | ${byFd.fullName} | odds="${pair.odds}" | fd="${fd.name}"`);
    } else if (byOdds) {
      await withRetry(() => prisma.team.update({ where: { id: byOdds.id }, data: { ...data, fullName: byOdds.fullName } }));
      updated++;
      console.log(`upd  ${fd.id} | ${byOdds.fullName} | odds="${pair.odds}" | fd="${fd.name}"`);
    } else if (byName) {
      await withRetry(() => prisma.team.update({ where: { id: byName.id }, data }));
      updated++;
      console.log(`upd  ${fd.id} | ${byName.fullName} | odds="${pair.odds}" | fd="${fd.name}"`);
    } else {
      await withRetry(() => prisma.team.create({ data }));
      created++;
      console.log(`new  ${fd.id} | ${pair.full} | odds="${pair.odds}" | fd="${fd.name}"`);
    }
  }

  console.log(`\nDone: ${created} created, ${updated} updated.`);
  if (problems.length) {
    console.log(`\nNotes (${problems.length}):`);
    for (const p of problems) console.log(`  - ${p}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());