import * as stagedGamesService from '../services/stagedGames.service';
import { isSportChoice } from '../services/stagedGames.service';
import ApiError from '../utils/ApiError';
import asyncHandler from '../utils/asyncHandler';

export const fetchAndStage = asyncHandler(async (req, res) => {
  const choice = (req.body as { choice?: unknown }).choice;
  if (!isSportChoice(choice)) throw new ApiError(400, "choice must be 'premier-league' or 'champions-league'");
  const result = await stagedGamesService.stageFromOdds(choice, req.user?.id);
  res.json({
    message: `Staged ${result.added} new game(s) for ${stagedGamesService.SPORTS[choice].label} (${result.fetched} fetched, ${result.alreadyStaged} already staged)`,
    data: result,
  });
});

export const listStaged = asyncHandler(async (req, res) => {
  const result = await stagedGamesService.listStagedGames(req.query as Record<string, unknown>);
  res.json(result);
});

export const listChampionsLeague = asyncHandler(async (req, res) => {
  const result = await stagedGamesService.listSportEvents('champions-league', req.query as Record<string, unknown>);
  res.json(result);
});

export const listPremierLeagueEvents = asyncHandler(async (req, res) => {
  const result = await stagedGamesService.listSportEvents('premier-league', req.query as Record<string, unknown>);
  res.json(result);
});

export const getStagedIds = asyncHandler(async (_req, res) => {
  const ids = await stagedGamesService.getStagedEventIds();
  res.json({ data: Array.from(ids) });
});

export const deleteSelected = asyncHandler(async (req, res) => {
  const result = await stagedGamesService.deleteStagedGames((req.body as { ids?: unknown }).ids, req.user?.id);
  const skippedNote = result.skipped > 0 ? ` (${result.skipped} skipped — already in games table)` : '';
  res.json({ message: `Deleted ${result.deleted} staged game(s)${skippedNote}`, data: result });
});

export const getStagedGame = asyncHandler(async (req, res) => {
  const data = await stagedGamesService.getStagedGame(req.params.id as string);
  res.json({ data });
});

export const findFootballData = asyncHandler(async (req, res) => {
  const result = await stagedGamesService.findFootballDataMatch(req.params.id as string);
  res.json(result);
});

export const linkFootballData = asyncHandler(async (req, res) => {
  const matchId = Number((req.body as { matchId?: unknown }).matchId);
  const data = await stagedGamesService.linkFootballDataMatch(req.params.id as string, matchId);
  res.json({ message: 'Football-data match linked', data });
});

export const unlinkFootballData = asyncHandler(async (req, res) => {
  const data = await stagedGamesService.unlinkFootballDataMatch(req.params.id as string);
  res.json({ message: 'Football-data match removed', data });
});

export const refreshFootballData = asyncHandler(async (req, res) => {
  const data = await stagedGamesService.refreshFootballDataMatch(req.params.id as string);
  res.json({ message: 'Football-data status refreshed', data });
});

export const confirmToGames = asyncHandler(async (req, res) => {
  const data = await stagedGamesService.confirmStagedGameToGames(req.params.id as string, req.user?.id);
  res.json({ message: 'Staged game added to the games table', data });
});
