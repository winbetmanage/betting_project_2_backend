import { Router } from 'express';
import * as clubLogoController from '../controllers/clubLogo.controller';

const router = Router();

// Public — used by the user site to fall back to an online club crest.
router.get('/', clubLogoController.resolve);

export default router;