import * as competitionService from '../services/competition.service';
import asyncHandler from '../utils/asyncHandler';

export const create = asyncHandler(async (req, res) => {
  const competition = await competitionService.createCompetition(req.body as Record<string, unknown>);
  res.status(201).json({ message: 'Competition created', data: competition });
});

export const list = asyncHandler(async (req, res) => {
  const competitions = await competitionService.listCompetitions(req.query as Record<string, unknown>);
  res.json({ data: competitions });
});

export const getById = asyncHandler(async (req, res) => {
  const competition = await competitionService.getCompetitionById(req.params.id as string);
  res.json({ data: competition });
});

export const update = asyncHandler(async (req, res) => {
  const competition = await competitionService.updateCompetition(req.params.id as string, req.body as Record<string, unknown>);
  res.json({ message: 'Competition updated', data: competition });
});
