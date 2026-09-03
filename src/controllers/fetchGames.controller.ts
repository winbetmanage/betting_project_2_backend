import * as fetchGamesService from '../services/fetchGames.service';
import * as eplResultService from '../services/eplResult.service';
import asyncHandler from '../utils/asyncHandler';

export const listPremierLeague = asyncHandler(async (req, res) => {
  const result = await fetchGamesService.listEplEvents(req.query as Record<string, unknown>);
  res.json({ data: result.data, total: result.total, page: result.page, limit: result.limit, totalPages: result.totalPages });
});

export const refreshPremierLeague = asyncHandler(async (req, res) => {
  const result = await fetchGamesService.fetchEplEvents(true);
  // after force refresh, return paginated list
  const paged = await fetchGamesService.listEplEvents(req.query as Record<string, unknown>);
  res.json({ message: `Refetched ${result.length} EPL events`, data: paged.data, total: paged.total, page: paged.page, limit: paged.limit, totalPages: paged.totalPages });
});

export const getPublishedIds = asyncHandler(async (_req, res) => {
  const ids = await fetchGamesService.getPublishedEventIds();
  res.json({ data: Array.from(ids) });
});

export const publishOne = asyncHandler(async (req, res) => {
  const game = await fetchGamesService.publishEplEvent(req.params.id as string);
  res.status(201).json({ message: 'Game added to games table', data: game });
});

export const publishBulk = asyncHandler(async (req, res) => {
  const ids = (req.body.ids as string[]) ?? [];
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('ids array required');
  const results = await fetchGamesService.publishEplEventsBulk(ids);
  const successCount = results.filter((r) => r.success).length;
  res.json({ message: `${successCount}/${ids.length} games added`, data: results });
});

export const listResults = asyncHandler(async (_req, res) => {
  const data = await eplResultService.listEplScores();
  res.json({ data });
});

export const fetchResults = asyncHandler(async (_req, res) => {
  const result = await eplResultService.fetchEplMatchesAndUpsert();
  const data = await eplResultService.listEplScores();
  res.json({ message: `${result.added} added, ${result.updated} updated (${result.total} total matches)`, data: data, stats: result });
});
