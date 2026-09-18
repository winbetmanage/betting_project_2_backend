import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';
import fs from 'fs';
import path from 'path';

/**
 * Market-type registry (src/config/marketTypes.json): marketKey -> { type, label }.
 * Loaded once at module load; falls back to built-ins if the file is missing.
 * NOTE: editing the JSON alone does not hot-reload a running server — restart
 * the backend (or touch this file) to pick up registry changes.
 */
type MarketTypeEntry = { type: string; label: string };

const BUILTIN_TYPES: Record<string, MarketTypeEntry> = {
  h2h: { type: 'MATCH_WINNER', label: 'Match Winner' },
  totals: { type: 'OVER_UNDER', label: 'Over/Under' },
  spreads: { type: 'HANDICAP', label: 'Handicap' },
  btts: { type: 'BOTH_TEAMS_TO_SCORE', label: 'Both Teams to Score' },
};

function loadMarketTypes(): Record<string, MarketTypeEntry> {
  const candidates = [
    path.join(__dirname, '..', 'config', 'marketTypes.json'),
    path.join(process.cwd(), 'src', 'config', 'marketTypes.json'),
  ];
  for (const f of candidates) {
    try {
      if (fs.existsSync(f)) {
        const raw = JSON.parse(fs.readFileSync(f, 'utf-8')) as Record<string, unknown>;
        const map: Record<string, MarketTypeEntry> = { ...BUILTIN_TYPES };
        for (const [k, v] of Object.entries(raw)) {
          if (k.startsWith('_')) continue;
          const e = v as MarketTypeEntry;
          if (e && typeof e.type === 'string' && typeof e.label === 'string') map[k] = e;
        }
        return map;
      }
    } catch {
      // fall through to built-ins
    }
  }
  return { ...BUILTIN_TYPES };
}

const MARKET_TYPES = loadMarketTypes();

// Fallback resolver so new/unknown variants don't all collapse to CUSTOM
function resolveMarketType(marketKey: string): string {
  if (MARKET_TYPES[marketKey]) return MARKET_TYPES[marketKey].type;
  if (marketKey.startsWith('h2h') || marketKey.startsWith('draw_no_bet') || marketKey.startsWith('double_chance')) return 'MATCH_WINNER';
  if (marketKey.startsWith('totals') || marketKey.startsWith('team_totals') || marketKey.startsWith('alternate_totals')) return 'OVER_UNDER';
  if (marketKey.startsWith('spreads') || marketKey.startsWith('alternate_spreads')) return 'HANDICAP';
  if (marketKey.startsWith('btts')) return 'BOTH_TEAMS_TO_SCORE';
  if (marketKey.startsWith('correct_score')) return 'CORRECT_SCORE';
  return 'CUSTOM';
}

function humanLabel(marketKey: string, point: number | null): string {
  const base = MARKET_TYPES[marketKey]?.label
    ?? marketKey.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
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

  const type = resolveMarketType(marketKey);
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