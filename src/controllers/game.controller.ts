import * as gameService from '../services/game.service';
import asyncHandler from '../utils/asyncHandler';

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
