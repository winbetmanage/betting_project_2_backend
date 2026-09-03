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

export const getById = asyncHandler(async (req, res) => {
  const game = await gameService.getGameById(req.params.id as string);
  res.json({ data: game });
});

export const update = asyncHandler(async (req, res) => {
  const game = await gameService.updateGame(req.params.id as string, req.body as Record<string, unknown>);
  res.json({ message: 'Game updated', data: game });
});
