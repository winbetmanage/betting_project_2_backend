const gameService = require('../services/game.service');
const asyncHandler = require('../utils/asyncHandler');

const create = asyncHandler(async (req, res) => {
  const game = await gameService.createGame(req.body);
  res.status(201).json({ message: 'Game created', data: game });
});

const list = asyncHandler(async (req, res) => {
  const games = await gameService.listGames(req.query);
  res.json({ data: games });
});

const getById = asyncHandler(async (req, res) => {
  const game = await gameService.getGameById(req.params.id);
  res.json({ data: game });
});

const update = asyncHandler(async (req, res) => {
  const game = await gameService.updateGame(req.params.id, req.body);
  res.json({ message: 'Game updated', data: game });
});

module.exports = { create, list, getById, update };
