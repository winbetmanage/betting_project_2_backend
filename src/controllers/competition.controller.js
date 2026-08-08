const competitionService = require('../services/competition.service');
const asyncHandler = require('../utils/asyncHandler');

const create = asyncHandler(async (req, res) => {
  const competition = await competitionService.createCompetition(req.body);
  res.status(201).json({ message: 'Competition created', data: competition });
});

const list = asyncHandler(async (req, res) => {
  const competitions = await competitionService.listCompetitions(req.query);
  res.json({ data: competitions });
});

const getById = asyncHandler(async (req, res) => {
  const competition = await competitionService.getCompetitionById(req.params.id);
  res.json({ data: competition });
});

const update = asyncHandler(async (req, res) => {
  const competition = await competitionService.updateCompetition(req.params.id, req.body);
  res.json({ message: 'Competition updated', data: competition });
});

module.exports = { create, list, getById, update };
