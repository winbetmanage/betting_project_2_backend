const betService = require('../services/bet.service');
const asyncHandler = require('../utils/asyncHandler');

const place = asyncHandler(async (req, res) => {
  const bet = await betService.placeBet(req.user.id, req.body);
  res.status(201).json({ message: 'Bet placed', data: bet });
});

const myBets = asyncHandler(async (req, res) => {
  const bets = await betService.getUserBets(req.user.id, req.query);
  res.json({ data: bets });
});

const getById = asyncHandler(async (req, res) => {
  const bet = await betService.getBetById(req.params.id, req.user.id, req.user.role === 'ADMIN');
  res.json({ data: bet });
});

const allBets = asyncHandler(async (req, res) => {
  const bets = await betService.getAllBets(req.query);
  res.json({ data: bets });
});

module.exports = { place, myBets, getById, allBets };
