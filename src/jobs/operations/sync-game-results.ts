import prisma from '../../utils/prisma';
import { resolveGameResult, fdStatusBucket } from '../../services/gameSettlement.service';
import { mapFootballDataStatus } from '../../services/stagedGames.service';
import { notify } from '../../services/notification.service';

export type SyncResultsSummary = { checked: number; finished: number; updated: number; skippedNoFd: number; stagedUpdated: number; errors: number };

export async function runSyncGameResults(): Promise<SyncResultsSummary> {
  const now = new Date();
  const games = await prisma.game.findMany({
    where: { status: { in: ['SCHEDULED', 'LIVE'] }, startTime: { lte: now } },
    select: { id: true, homeTeam: true, awayTeam: true, startTime: true, isPublished: true },
    orderBy: { startTime: 'asc' },
  });

  const summary: SyncResultsSummary = { checked: 0, finished: 0, updated: 0, skippedNoFd: 0, stagedUpdated: 0, errors: 0 };

  for (const g of games) {
    let result;
    try {
      result = await resolveGameResult(g.id);
    } catch (e) {
      summary.errors++;
      console.error(`[sync-game-results] ${g.homeTeam} vs ${g.awayTeam} error:`, e instanceof Error ? e.message : String(e));
      continue;
    }

    if (result.source === 'none') {
      summary.skippedNoFd++;
      continue;
    }
    summary.checked++;

    const current = await prisma.game.findUnique({ where: { id: g.id }, select: { status: true } });
    const curStatus = current?.status;

    let next: 'SCHEDULED' | 'LIVE' | 'FINISHED' | 'POSTPONED' | 'CANCELLED' | 'SUSPENDED' | null = null;
    if (result.finished) next = 'FINISHED';
    else {
      const bucket = fdStatusBucket(result.matchStatus);
      if (bucket === 'LIVE') next = 'LIVE';
      else if (bucket === 'POSTPONED') next = 'POSTPONED';
      else if (bucket === 'CANCELLED') next = 'CANCELLED';
      else if (bucket === 'SUSPENDED') next = 'SUSPENDED';
      else next = 'SCHEDULED';
    }

    if (next && next !== curStatus) {
      await prisma.game.update({ where: { id: g.id }, data: { status: next } });
      summary.updated++;
      if (next === 'FINISHED') {
        summary.finished++;
        if (g.isPublished) {
          await notify({
            audience: 'ADMIN',
            userId: null,
            type: 'GAME_FINISHED',
            title: `Finished: ${g.homeTeam} vs ${g.awayTeam}`,
            message: `Final ${result.homeFT ?? '?'}–${result.awayFT ?? '?'} — ready to settle`,
            linkUrl: `/admin/bet-games/${g.id}`,
          });
        }
      }
      console.log(`[sync-game-results] ${g.homeTeam} vs ${g.awayTeam}: ${curStatus} -> ${next} (${result.homeFT}-${result.awayFT})`);
    }

    // Mirror the football-data status onto the linked StagedGame, but only for staged
    // rows that were already promoted into the Games table (StagedGame.gameId set).
    try {
      const mappedFdStatus = mapFootballDataStatus(result.matchStatus);
      if (mappedFdStatus) {
        const staged = await prisma.stagedGame.findUnique({ where: { gameId: g.id }, select: { id: true, footballDataStatus: true } });
        if (staged && staged.footballDataStatus !== mappedFdStatus) {
          await prisma.stagedGame.update({ where: { id: staged.id }, data: { footballDataStatus: mappedFdStatus } });
          summary.stagedUpdated++;
          console.log(`[sync-game-results] staged ${staged.id} footballDataStatus -> ${mappedFdStatus} (from ${result.matchStatus})`);
        }
      }
    } catch (e) {
      console.error(`[sync-game-results] staged status mirror failed for game ${g.id}:`, e instanceof Error ? e.message : String(e));
    }
  }

  // Self-heal: games that reached FINISHED in a previous run (or via another path) but whose
  // linked StagedGame still shows an older footballDataStatus get corrected here. Only touches
  // staged rows already promoted into Games (gameId not null).
  try {
    const stale = await prisma.stagedGame.findMany({
      where: {
        gameId: { not: null },
        NOT: { footballDataStatus: 'FINISHED' },
        game: { status: 'FINISHED' },
      },
      select: { id: true },
    });
    if (stale.length > 0) {
      await prisma.stagedGame.updateMany({ where: { id: { in: stale.map((s) => s.id) } }, data: { footballDataStatus: 'FINISHED' } });
      summary.stagedUpdated += stale.length;
      console.log(`[sync-game-results] self-heal set ${stale.length} linked staged footballDataStatus -> FINISHED`);
    }
  } catch (e) {
    console.error('[sync-game-results] self-heal pass failed:', e instanceof Error ? e.message : String(e));
  }

  return summary;
}
