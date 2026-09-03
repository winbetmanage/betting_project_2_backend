import prisma from '../utils/prisma';
import ApiError from '../utils/ApiError';
import * as eplGameOdds from './eplGameOdds.service';

export async function fetchAndStoreForGame(gameId: string) {
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) throw new ApiError(404, 'Game not found');
  if (!game.externalEventId) throw new ApiError(400, 'Game has no externalEventId');
  const bookmakers = await eplGameOdds.fetchAndSaveGameOdds(game.externalEventId);
  return { stored: bookmakers, eventId: game.externalEventId };
}

export async function getGroupedForGame(gameId: string) {
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) throw new ApiError(404, 'Game not found');
  if (!game.externalEventId) return { game, groups: [] };

  const raw = eplGameOdds.readGameOdds(game.externalEventId);
  if (!raw) return { game, groups: [] };
  const groups = eplGameOdds.groupOdds(raw);
  return { game, groups };
}

export { hasJsonFor, jsonPathFor, readGameOdds, groupOdds, fetchAndSaveGameOdds } from './eplGameOdds.service';
