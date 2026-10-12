import * as stagedGamesService from '../services/stagedGames.service';
import { isSportChoice, type SportChoice } from '../services/stagedGames.service';
import ApiError from '../utils/ApiError';
import asyncHandler from '../utils/asyncHandler';

const VALID_CHOICES = Object.keys(stagedGamesService.SPORTS).join("', '");

export const fetchAndStage = asyncHandler(async (req, res) => {
  const choice = (req.body as { choice?: unknown }).choice;
  if (!isSportChoice(choice)) throw new ApiError(400, `choice must be one of '${VALID_CHOICES}'`);
  const result = await stagedGamesService.stageFromOdds(choice, req.user?.id);
  res.json({
    message: `Staged ${result.added} new game(s) for ${stagedGamesService.SPORTS[choice].label} (${result.fetched} fetched, ${result.alreadyStaged} already staged)`,
    data: result,
  });
});

export const stageSelected = asyncHandler(async (req, res) => {
  const { choice, eventIds } = req.body as { choice?: unknown; eventIds?: unknown };
  if (!isSportChoice(choice)) throw new ApiError(400, `choice must be one of '${VALID_CHOICES}'`);
  const result = await stagedGamesService.stageSelectedEvents(choice, eventIds, req.user?.id);
  res.json({
    message: `Staged ${result.added} game(s) for ${stagedGamesService.SPORTS[choice].label} (${result.alreadyStaged} already staged, ${result.unresolved.length} skipped)`,
    data: result,
  });
});

export const refreshStaged = asyncHandler(async (_req, res) => {
  const result = await stagedGamesService.refreshStagedGames();
  const errNote = result.errors.length > 0 ? `, ${result.errors.length} error(s)` : '';
  res.json({
    message: `Refreshed ${result.checked} staged game(s): ${result.oddsUpdated} kickoff update(s), ${result.fdUpdated} football-data update(s)${errNote}`,
    data: result,
  });
});

export const listStaged = asyncHandler(async (req, res) => {
  const result = await stagedGamesService.listStagedGames(req.query as Record<string, unknown>);
  res.json(result);
});

export const listSport = (choice: SportChoice) =>
  asyncHandler(async (req, res) => {
    const result = await stagedGamesService.listSportEvents(choice, req.query as Record<string, unknown>);
    res.json(result);
  });

export const listChampionsLeague = listSport('champions-league');

export const listPremierLeagueEvents = listSport('premier-league');

export const listLaLiga = listSport('la-liga');

export const listBundesliga = listSport('bundesliga');

export const listSerieA = listSport('serie-a');

export const listLigue1 = listSport('ligue-1');

export const getStagedIds = asyncHandler(async (_req, res) => {
  const ids = await stagedGamesService.getStagedEventIds();
  res.json({ data: Array.from(ids) });
});

export const deleteSelected = asyncHandler(async (req, res) => {
  const result = await stagedGamesService.deleteStagedGames((req.body as { ids?: unknown }).ids, req.user?.id);
  const skippedNote = result.skipped > 0 ? ` (${result.skipped} skipped — already in games table)` : '';
  res.json({ message: `Deleted ${result.deleted} staged game(s)${skippedNote}`, data: result });
});

export const clearFinished = asyncHandler(async (req, res) => {
  const result = await stagedGamesService.clearFinishedStagedGames(req.user?.id);
  res.json({ message: `Cleared ${result.deleted} finished staged game(s)`, data: result });
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

export const bulkFindAndLink = asyncHandler(async (req, res) => {
  const ids = (req.body as { ids?: unknown }).ids;
  const result = await stagedGamesService.bulkFindAndLinkFootballData(ids);
  const s = result.summary;
  res.json({
    message: `Auto find & link: ${s.linked ?? 0} linked, ${s.already_linked ?? 0} already linked, ${(s.not_found ?? 0) + (s.teams_not_mapped ?? 0) + (s.linked_conflict ?? 0)} not linked`,
    data: result,
  });
});

export const bulkConfirm = asyncHandler(async (req, res) => {
  const ids = (req.body as { ids?: unknown }).ids;
  const result = await stagedGamesService.bulkConfirmStagedGames(ids, req.user?.id);
  const s = result.summary;
  res.json({
    message: `Added ${s.added ?? 0} game(s) to the games table${(s.skipped ?? 0) > 0 ? `, ${s.skipped} skipped` : ""}${(s.error ?? 0) > 0 ? `, ${s.error} failed` : ""}`,
    data: result,
  });
});
