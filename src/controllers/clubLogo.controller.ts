import { resolveClubLogoOnline } from '../services/clubLogo.service';
import asyncHandler from '../utils/asyncHandler';

/**
 * Public club-logo resolver used as the permanent fallback for any club that
 * has no local SVG. Redirects (302) to a verified Wikimedia crest, or 404 so the
 * client can fall back to its placeholder/letter badge.
 */
export const resolve = asyncHandler(async (req, res) => {
  const name = String((req.query.name as string) ?? '').trim();
  if (!name) {
    res.status(400).json({ message: 'name is required' });
    return;
  }
  const url = await resolveClubLogoOnline(name);
  if (!url) {
    res.status(404).json({ message: 'No online logo found' });
    return;
  }
  // Cache the redirect at the CDN/browser for a day.
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.redirect(302, url);
});