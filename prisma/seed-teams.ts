import "dotenv/config";
import { readFileSync, readdirSync } from "fs";
import path from "path";
import prisma from "../src/utils/prisma";

type TeamSeed = {
  fullName: string;
  shortName: string;
  oddsApiName: string;
  footballDataName: string;
  footballDataTeamId: number;
  iconUrl: string;
  country: string;
  isNational: boolean;
};

const TRANSIENT_ERRORS = ["Server has closed", "max_statement_time", "Can't reach"];

async function withRetry<T>(fn: () => Promise<T>, tries = 5, waitMs = 4000): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (TRANSIENT_ERRORS.some((s) => msg.includes(s))) {
        console.log(`  (db busy, retry ${i + 1}/${tries} in ${waitMs}ms)`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function main() {
  const dataDir = path.resolve(__dirname, "..", "src", "utils", "useful_data");
  const files = readdirSync(dataDir).filter((f) => /^team_names_link.*\.json$/i.test(f)).sort();
  const seen = new Set<number>();
  const teams: TeamSeed[] = [];
  for (const f of files) {
    const list = JSON.parse(readFileSync(path.join(dataDir, f), "utf-8")) as TeamSeed[];
    for (const t of list) {
      if (typeof t.footballDataTeamId === "number") {
        if (seen.has(t.footballDataTeamId)) continue;
        seen.add(t.footballDataTeamId);
      }
      teams.push(t);
    }
  }
  console.log(`Seeding ${teams.length} teams from ${files.length} file(s): ${files.join(", ")}\n`);

  const failures: { team: string; error: string }[] = [];
  let done = 0;

  for (const t of teams) {
    if (typeof t.footballDataTeamId !== "number") {
      failures.push({ team: t.fullName, error: "missing footballDataTeamId" });
      continue;
    }

    const data = {
      fullName: t.fullName,
      shortName: t.shortName ?? null,
      oddsApiName: t.oddsApiName ?? null,
      footballDataName: t.footballDataName ?? null,
      footballDataTeamId: t.footballDataTeamId,
      iconUrl: t.iconUrl ?? null,
      country: t.country ?? null,
      isNational: t.isNational ?? false,
    };

    try {
      await withRetry(async () => {
        const byFdId = await prisma.team.findFirst({ where: { footballDataTeamId: t.footballDataTeamId }, select: { id: true } });
        if (byFdId) return prisma.team.update({ where: { id: byFdId.id }, data });
        const byOdds = t.oddsApiName ? await prisma.team.findFirst({ where: { oddsApiName: t.oddsApiName }, select: { id: true } }) : null;
        if (byOdds) return prisma.team.update({ where: { id: byOdds.id }, data });
        return prisma.team.create({ data });
      });
      done++;
      console.log(`  [${done}/${teams.length}] ${t.fullName} (id ${t.footballDataTeamId})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push({ team: t.fullName, error: msg });
      console.error(`  FAILED ${t.fullName}: ${msg}`);
    }
  }

  const total = await withRetry(() => prisma.team.count());
  console.log(`\nDone: ${done}/${teams.length} seeded, teams in table: ${total}`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(`  - ${f.team}: ${f.error}`);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
