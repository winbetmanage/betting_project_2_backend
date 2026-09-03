import * as bookmakerOddsService from '../services/bookmakerOdds.service';
import * as marketApprovalService from '../services/marketApproval.service';
import asyncHandler from '../utils/asyncHandler';
import prisma from '../utils/prisma';

export const fetchForGame = asyncHandler(async (req, res) => {
  const result = await bookmakerOddsService.fetchAndStoreForGame(req.params.id as string);
  res.json({ message: `Fetched ${result.stored} odds`, data: result });
});

export const getGroupedForGame = asyncHandler(async (req, res) => {
  const result = await bookmakerOddsService.getGroupedForGame(req.params.id as string);
  const gameId = req.params.id as string;
  const game = await prisma.game.findUnique({ where: { id: gameId }, include: { markets: true } });
  const hasJson = result.game.externalEventId ? bookmakerOddsService.hasJsonFor(result.game.externalEventId) : false;
  const hasSelection = (game?.markets?.length ?? 0) > 0;
  // Which group keys already have a saved Market (to highlight in UI)
  const TYPE_TO_KEY: Record<string, string> = { MATCH_WINNER: 'h2h', OVER_UNDER: 'totals', HANDICAP: 'spreads', BOTH_TEAMS_TO_SCORE: 'btts', CORRECT_SCORE: 'correct_score' };
  const savedKeys = (game?.markets ?? [])
    .map((m) => {
      const p = m.parameters as { marketKey?: string; line?: number | null } | null;
      const mk = p?.marketKey ?? TYPE_TO_KEY[m.type] ?? m.type.toLowerCase();
      const pt = p?.line != null ? String(p.line) : 'null';
      return `${mk}::${pt}`;
    });
  res.json({ data: result.groups, game: result.game, hasJson, hasSelection, savedKeys });
});

export const approveMarket = asyncHandler(async (req, res) => {
  const gameId = req.params.id as string;
  const adminUserId = req.user!.id;
  const { marketKey, point, bookmakerKey, selections } = req.body as {
    marketKey: string;
    point?: number | null;
    bookmakerKey: string;
    selections: { name: string; odds: number }[];
  };
  const market = await marketApprovalService.approveMarket(gameId, { marketKey, point: point ?? null, bookmakerKey, selections }, adminUserId);
  res.json({ message: 'Market approved', data: market });
});

export const approveMarketsBulk = asyncHandler(async (req, res) => {
  const gameId = req.params.id as string;
  const adminUserId = req.user!.id;
  const { approvals } = req.body as {
    approvals: { marketKey: string; point?: number | null; bookmakerKey: string; selections: { name: string; odds: number }[] }[];
  };
  if (!Array.isArray(approvals) || approvals.length === 0) {
    res.status(400).json({ message: 'approvals array required' });
    return;
  }
  const results = [];
  for (const a of approvals) {
    try {
      const market = await marketApprovalService.approveMarket(gameId, { marketKey: a.marketKey, point: a.point ?? null, bookmakerKey: a.bookmakerKey, selections: a.selections }, adminUserId);
      results.push({ marketKey: a.marketKey, point: a.point ?? null, success: true, marketId: market!.id });
    } catch (e) {
      results.push({ marketKey: a.marketKey, point: a.point ?? null, success: false, message: e instanceof Error ? e.message : 'Failed' });
    }
  }
  const ok = results.filter((r) => r.success).length;
  res.json({ message: `${ok}/${results.length} markets recorded`, data: results });
});
