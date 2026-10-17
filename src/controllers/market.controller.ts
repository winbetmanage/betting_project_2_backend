import * as marketService from '../services/market.service';
import * as marketReplaceService from '../services/marketReplace.service';
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

export const setVisibility = asyncHandler(async (req, res) => {
  const { hidden } = req.body as { hidden?: unknown };
  if (typeof hidden !== 'boolean') throw new ApiError(400, 'hidden must be true or false');
  const result = await marketService.setMarketHidden(req.params.id as string, hidden, req.user!.id);
  res.json({
    message: result.changed
      ? hidden
        ? `Hidden from the betting list — ${result.betCount} existing ticket(s) left as they are`
        : 'Back on the betting list'
      : `Already ${hidden ? 'hidden' : 'open'} — nothing changed`,
    data: result,
  });
});

export const replaceOptions = asyncHandler(async (req, res) => {
  const data = await marketReplaceService.getReplaceOptions(req.params.id as string);
  res.json({ data });
});

export const replacePreview = asyncHandler(async (req, res) => {
  const { candidateKey } = req.body as { candidateKey?: string };
  if (!candidateKey) throw new ApiError(400, 'candidateKey is required');
  const data = await marketReplaceService.previewReplace(req.params.id as string, candidateKey);
  res.json({ data });
});

export const replace = asyncHandler(async (req, res) => {
  const { candidateKey, plans } = req.body as marketReplaceService.ReplaceInput;
  const data = await marketReplaceService.replaceMarket(
    req.params.id as string,
    { candidateKey, plans },
    req.user!.id
  );
  res.json({
    message: `Market replaced — ${data.betsUpdated} ticket(s) updated, ${data.legsRewritten} leg(s) rewritten, ${data.legsVoided} voided`,
    data,
  });
});
