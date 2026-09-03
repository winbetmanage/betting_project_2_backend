import * as staticGamesService from '../services/staticGames.service';
import asyncHandler from '../utils/asyncHandler';

export const list = asyncHandler(async (req, res) => {
  const result = staticGamesService.listStaticGames(req.query as Record<string, unknown>);
  res.json({ data: result.data, total: result.total, page: result.page, limit: result.limit, totalPages: result.totalPages, groups: result.groups });
});

export const getByKey = asyncHandler(async (req, res) => {
  const game = staticGamesService.getStaticGameByKey(req.params.key as string);
  res.json({ data: game });
});

export const refetch = asyncHandler(async (_req, res) => {
  const result = await staticGamesService.refetchAndSave();
  res.json({ message: 'Refetched and saved', data: result });
});
