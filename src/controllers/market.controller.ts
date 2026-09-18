import * as marketService from '../services/market.service';
import asyncHandler from '../utils/asyncHandler';
import ApiError from '../utils/ApiError';

export const create = asyncHandler(async (req, res) => {
  const market = await marketService.createMarket(req.params.gameId as string, req.body as Record<string, unknown>);
  res.status(201).json({ message: 'Market created', data: market });
});

export const listByGame = asyncHandler(async (req, res) => {
  const markets = await marketService.listMarkets(req.params.gameId as string);
  res.json({ data: markets });
});

export const getById = asyncHandler(async (req, res) => {
  const market = await marketService.getMarketById(req.params.id as string);
  res.json({ data: market });
});

export const update = asyncHandler(async (req, res) => {
  const market = await marketService.updateMarket(req.params.id as string, req.body as Record<string, unknown>, req.user!.id);
  res.json({ message: 'Market updated', data: market });
});

export const addSelection = asyncHandler(async (req, res) => {
  const selection = await marketService.addSelection(req.params.id as string, req.body as Record<string, unknown>);
  res.status(201).json({ message: 'Selection added', data: selection });
});

export const updateSelection = asyncHandler(async (req, res) => {
  const selection = await marketService.updateSelection(req.params.id as string, req.body as Record<string, unknown>);
  res.json({ message: 'Selection updated', data: selection });
});

export const updateOdds = asyncHandler(async (req, res) => {
  const selection = await marketService.updateOdds(req.params.id as string, (req.body as { odds: number }).odds);
  res.json({ message: 'Odds updated', data: selection });
});

export const settle = asyncHandler(async (req, res) => {
  const { isWinning } = req.body as { isWinning?: boolean | null };
  if (isWinning !== true && isWinning !== false && isWinning !== null) {
    throw new ApiError(400, 'isWinning must be true, false or null (null = void/push)');
  }
  const result = await marketService.settleSelection(req.params.id as string, isWinning);
  res.json({ message: 'Selection settled', data: result });
});

export const remove = asyncHandler(async (req, res) => {
  const result = await marketService.removeMarket(req.params.id as string);
  res.json({ message: 'Market removed', data: result });
});
