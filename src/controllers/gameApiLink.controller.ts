import * as gameApiLinkService from '../services/gameApiLink.service';
import asyncHandler from '../utils/asyncHandler';
import ApiError from '../utils/ApiError';

export const links = asyncHandler(async (req, res) => {
  const data = await gameApiLinkService.getGameApiLinks(req.params.id as string);
  res.json({ data });
});

export const findFd = asyncHandler(async (req, res) => {
  const data = await gameApiLinkService.findFootballDataForGame(req.params.id as string);
  res.json({ data });
});

export const findOdds = asyncHandler(async (req, res) => {
  const data = await gameApiLinkService.findOddsEventsForGame(req.params.id as string);
  res.json({ data });
});

export const linkFd = asyncHandler(async (req, res) => {
  const matchId = Number((req.body as { matchId?: unknown }).matchId);
  if (!Number.isFinite(matchId)) throw new ApiError(400, 'matchId is required');
  const data = await gameApiLinkService.linkFootballDataForGame(req.params.id as string, matchId, req.user?.id);
  res.json({ message: 'football-data match linked', data });
});

export const unlinkFd = asyncHandler(async (req, res) => {
  const data = await gameApiLinkService.unlinkFootballDataForGame(req.params.id as string, req.user?.id);
  res.json({ message: 'football-data match unlinked', data });
});

export const linkOdds = asyncHandler(async (req, res) => {
  const eventId = String((req.body as { eventId?: unknown }).eventId ?? '');
  const data = await gameApiLinkService.linkOddsEventForGame(req.params.id as string, eventId, req.user?.id);
  res.json({ message: eventId.trim() ? 'Odds API event linked' : 'Odds API event removed', data });
});
