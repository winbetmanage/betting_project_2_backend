const sportService = require('../services/sport.service');
const asyncHandler = require('../utils/asyncHandler');

const create = asyncHandler(async (req, res) => {
  const sport = await sportService.createSport(req.body);
  res.status(201).json({ message: 'Sport created', data: sport });
});

const list = asyncHandler(async (req, res) => {
  const sports = await sportService.listSports(req.query);
  res.json({ data: sports });
});

const getById = asyncHandler(async (req, res) => {
  const sport = await sportService.getSportById(req.params.id);
  res.json({ data: sport });
});

const update = asyncHandler(async (req, res) => {
  const sport = await sportService.updateSport(req.params.id, req.body);
  res.json({ message: 'Sport updated', data: sport });
});

module.exports = { create, list, getById, update };
