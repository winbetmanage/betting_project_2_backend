import * as sportService from '../services/sport.service';
import asyncHandler from '../utils/asyncHandler';
import type { Prisma } from '@prisma/client';

export const create = asyncHandler(async (req, res) => {
  const sport = await sportService.createSport(req.body as Prisma.SportCreateInput);
  res.status(201).json({ message: 'Sport created', data: sport });
});

export const list = asyncHandler(async (req, res) => {
  const sports = await sportService.listSports(req.query as Record<string, unknown>);
  res.json({ data: sports });
});

export const getById = asyncHandler(async (req, res) => {
  const sport = await sportService.getSportById(req.params.id as string);
  res.json({ data: sport });
});

export const update = asyncHandler(async (req, res) => {
  const sport = await sportService.updateSport(req.params.id as string, req.body as Prisma.SportUpdateInput);
  res.json({ message: 'Sport updated', data: sport });
});
