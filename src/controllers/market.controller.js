const marketService = require('../services/market.service');
const asyncHandler = require('../utils/asyncHandler');

const create = asyncHandler(async (req, res) => {
  const market = await marketService.createMarket(req.params.gameId, req.body);
  res.status(201).json({ message: 'Market created', data: market });
});

const listByGame = asyncHandler(async (req, res) => {
  const markets = await marketService.listMarkets(req.params.gameId);
  res.json({ data: markets });
});

const getById = asyncHandler(async (req, res) => {
  const market = await marketService.getMarketById(req.params.id);
  res.json({ data: market });
});

const update = asyncHandler(async (req, res) => {
  const market = await marketService.updateMarket(req.params.id, req.body);
  res.json({ message: 'Market updated', data: market });
});

const addSelection = asyncHandler(async (req, res) => {
  const selection = await marketService.addSelection(req.params.id, req.body);
  res.status(201).json({ message: 'Selection added', data: selection });
});

const updateSelection = asyncHandler(async (req, res) => {
  const selection = await marketService.updateSelection(req.params.id, req.body);
  res.json({ message: 'Selection updated', data: selection });
});

const updateOdds = asyncHandler(async (req, res) => {
  const selection = await marketService.updateOdds(req.params.id, req.body.odds);
  res.json({ message: 'Odds updated', data: selection });
});

const settle = asyncHandler(async (req, res) => {
  const result = await marketService.settleSelection(req.params.id, req.body.isWinning);
  res.json({ message: 'Selection settled', data: result });
});

module.exports = { create, listByGame, getById, update, addSelection, updateSelection, updateOdds, settle };
