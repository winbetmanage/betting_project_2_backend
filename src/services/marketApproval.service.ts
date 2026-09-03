import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';

const MARKET_TYPE_MAP: Record<string, string> = {
  h2h: 'MATCH_WINNER',
  h2h_3_way: 'MATCH_WINNER',
  draw_no_bet: 'MATCH_WINNER',
  double_chance: 'MATCH_WINNER',
  h2h_h1: 'MATCH_WINNER',
  h2h_h2: 'MATCH_WINNER',
  totals: 'OVER_UNDER',
  totals_h1: 'OVER_UNDER',
  totals_h2: 'OVER_UNDER',
  team_totals: 'OVER_UNDER',
  spreads: 'HANDICAP',
  btts: 'BOTH_TEAMS_TO_SCORE',
  btts_h1: 'BOTH_TEAMS_TO_SCORE',
  correct_score: 'CORRECT_SCORE',
  correct_score_h1: 'CORRECT_SCORE',
  halftime_fulltime: 'CUSTOM',
  corners_1x2: 'CUSTOM',
  alternate_spreads: 'CUSTOM',
  alternate_totals: 'CUSTOM',
  alternate_team_totals: 'CUSTOM',
  alternate_totals_corners: 'CUSTOM',
  alternate_spreads_corners: 'CUSTOM',
  alternate_totals_cards: 'CUSTOM',
  alternate_spreads_cards: 'CUSTOM',
};

function humanLabel(marketKey: string, point: number | null): string {
  const known: Record<string, string> = {
    h2h: 'Match Winner',
    totals: 'Over/Under',
    spreads: 'Handicap',
    h2h_3_way: 'Match Winner (3-Way)',
    btts: 'Both Teams to Score',
    draw_no_bet: 'Draw No Bet',
    double_chance: 'Double Chance',
    h2h_h1: 'First Half Winner',
    h2h_h2: 'Second Half Winner',
    totals_h1: 'First Half Totals',
    totals_h2: 'Second Half Totals',
    btts_h1: 'First Half BTTS',
    double_chance_h1: 'First Half Double Chance',
    correct_score: 'Correct Score',
    correct_score_h1: 'First Half Correct Score',
    halftime_fulltime: 'Half-Time/Full-Time',
    team_totals: 'Team Totals',
    alternate_spreads: 'Alternate Spreads',
    alternate_totals: 'Alternate Totals',
    alternate_team_totals: 'Alternate Team Totals',
    corners_1x2: 'Corners 1X2',
    alternate_totals_corners: 'Alternate Corner Totals',
    alternate_spreads_corners: 'Alternate Corner Spreads',
    alternate_totals_cards: 'Alternate Card Totals',
    alternate_spreads_cards: 'Alternate Card Spreads',
  };
  const base = known[marketKey] ?? marketKey.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  if (point != null) return `${base} — line ${point}`;
  return base;
}

type ApproveInput = {
  marketKey: string;
  point?: number | null;
  bookmakerKey: string;
  selections: { name: string; odds: number }[];
};

export async function approveMarket(gameId: string, input: ApproveInput, adminUserId: string) {
  const { marketKey, point, bookmakerKey, selections } = input;

  if (!bookmakerKey || !selections?.length) throw new ApiError(400, 'bookmakerKey and selections required');
  for (const s of selections) {
    if (!s.name || !s.odds || s.odds <= 1) throw new ApiError(400, `Invalid selection ${s.name}`);
  }

  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) throw new ApiError(404, 'Game not found');
  if (!game.externalEventId) throw new ApiError(400, 'Game has no externalEventId');

  const type = MARKET_TYPE_MAP[marketKey] ?? 'CUSTOM';
  const baseName = humanLabel(marketKey, null);
  const name = point != null ? `${baseName} — line ${point}` : baseName;
  const parameters = { marketKey, line: point ?? null };

  // Find existing market for this game+type+marketKey+line (manual check due to Json filtering)
  const candidates = await prisma.market.findMany({ where: { gameId, type: type as never }, include: { selections: true } });
  let market = candidates.find((m) => {
    const p = m.parameters as { line?: number | null; marketKey?: string } | null;
    // Match the exact source market key too, so h2h vs h2h_3_way (both MATCH_WINNER) stay separate
    if (p?.marketKey && p.marketKey !== marketKey) return false;
    if (point == null && (p == null || p.line == null)) return true;
    if (point != null && p && p.line === point) return true;
    return false;
  }) ?? null;

  const now = new Date();
  const sourceKeys = [bookmakerKey];

  if (!market) {
    market = await prisma.market.create({
      data: {
        gameId,
        type: type as never,
        name,
        status: 'OPEN',
        parameters: parameters as never,
        sourceBookmakerKeys: sourceKeys,
        lastSourceCheckedAt: now,
        selections: {
          create: selections.map((s) => ({
            name: s.name,
            odds: s.odds,
          })),
        },
      },
      include: { selections: true },
    });

    await prisma.adminActionLog.create({
      data: {
        userId: adminUserId,
        action: 'MARKET_SOURCE_ADDED',
        targetType: 'Market',
        targetId: market.id,
        metadata: { marketKey, point, bookmakerKey, oldBookmakerKeys: null, newBookmakerKeys: sourceKeys, selections: selections.map((s) => ({ name: s.name, odds: s.odds })) },
      },
    });

    return market;
  }

  // Update existing
  const oldKeys = (market.sourceBookmakerKeys as string[] | null) ?? [];
  const oldSelections = market.selections;

  await prisma.market.update({
    where: { id: market.id },
    data: { sourceBookmakerKeys: sourceKeys, lastSourceCheckedAt: now, name, parameters: parameters as never },
  });

  for (const sel of selections) {
    const existingSel = oldSelections.find((s) => s.name === sel.name);
    if (existingSel) {
      if (Number(existingSel.odds) !== Number(sel.odds)) {
        await prisma.selection.update({ where: { id: existingSel.id }, data: { odds: sel.odds } });
        await prisma.oddsHistory.create({ data: { selectionId: existingSel.id, odds: sel.odds } });
      }
    } else {
      await prisma.selection.create({ data: { marketId: market.id, name: sel.name, odds: sel.odds } });
    }
  }

  await prisma.adminActionLog.create({
    data: {
      userId: adminUserId,
      action: 'MARKET_SOURCE_UPDATED',
      targetType: 'Market',
      targetId: market.id,
      metadata: { marketKey, point, oldBookmakerKeys: oldKeys, newBookmakerKeys: sourceKeys, selections: selections.map((s) => ({ name: s.name, odds: s.odds })), oldSelections: oldSelections.map((s) => ({ name: s.name, odds: Number(s.odds) })) },
    },
  });

  const updated = await prisma.market.findUnique({ where: { id: market.id }, include: { selections: true } });
  return updated;
}