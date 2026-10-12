import * as gameService from '../services/game.service';
import * as bookmakerOddsService from '../services/bookmakerOdds.service';
import asyncHandler from '../utils/asyncHandler';
import ApiError from '../utils/ApiError';

export const create = asyncHandler(async (req, res) => {
  const game = await gameService.createGame(req.body as Record<string, unknown>);
  res.status(201).json({ message: 'Game created', data: game });
});

export const list = asyncHandler(async (req, res) => {
  const games = await gameService.listGames(req.query as Record<string, unknown>);
  res.json({ data: games });
});

export const results = asyncHandler(async (req, res) => {
  const limit = Number(req.query.limit) || 10;
  const games = await gameService.listRecentResults(limit);
  res.json({ data: games });
});

export const getById = asyncHandler(async (req, res) => {
  const game = await gameService.getGameById(req.params.id as string);
  res.json({ data: game });
});

export const update = asyncHandler(async (req, res) => {
  const game = await gameService.updateGame(req.params.id as string, req.body as Record<string, unknown>, req.user!.id);
  res.json({ message: 'Game updated', data: game });
});

export const removeBulk = asyncHandler(async (req, res) => {
  const result = await gameService.deleteGames((req.body as { ids?: unknown }).ids);
  res.json({ message: `Deleted ${result.deleted} game(s)`, data: result });
});

export const clearAllGamesData = asyncHandler(async (req, res) => {
  const result = await gameService.clearAllGameData({
    confirm: (req.body as { confirm?: unknown }).confirm,
    adminId: req.user?.id,
  });
  res.json({ message: `Cleared all game data (${result.games} game(s) deleted)`, data: result });
});

export const refreshTimes = asyncHandler(async (_req, res) => {
  const result = await gameService.refreshUpcomingTimes();
  const errNote = result.errors.length > 0 ? `, ${result.errors.length} error(s)` : '';
  res.json({ message: `Checked ${result.checked} game(s), updated ${result.updated} kickoff time(s)${errNote}`, data: result });
});

const parseIds = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) throw new ApiError(400, 'ids (array) is required');
  const ids = raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (ids.length === 0) throw new ApiError(400, 'ids (non-empty array) is required');
  return ids;
};

export const marketTypes = asyncHandler(async (_req, res) => {
  res.json({ data: bookmakerOddsService.listMarketTypes() });
});

export const bulkFetchOdds = asyncHandler(async (req, res) => {
  const ids = parseIds((req.body as { ids?: unknown }).ids);
  const report = await bookmakerOddsService.bulkFetchOdds(ids);
  res.json({
    message: `Fetched markets for ${report.succeeded}/${report.total} game(s)${report.failed > 0 ? ` (${report.failed} failed)` : ''}`,
    data: report,
  });
});

export const bulkAutoFill = asyncHandler(async (req, res) => {
  const body = req.body as { ids?: unknown; scoreOnly?: unknown; excludeMarketKeys?: unknown };
  const ids = parseIds(body.ids);
  const scoreOnly = body.scoreOnly !== false; // default: scores only
  const excludeMarketKeys = Array.isArray(body.excludeMarketKeys)
    ? body.excludeMarketKeys.filter((v): v is string => typeof v === 'string')
    : [];
  const report = await bookmakerOddsService.bulkAutoFill(ids, { scoreOnly, excludeMarketKeys, adminUserId: req.user!.id });
  const filledGames = report.items.filter((i) => (i as { marketsFilled?: number }).marketsFilled && (i as { marketsFilled?: number }).marketsFilled! > 0).length;
  res.json({
    message: `Auto-filled markets on ${filledGames}/${report.total} game(s)${report.failed > 0 ? ` (${report.failed} had issues)` : ''}`,
    data: report,
  });
});
