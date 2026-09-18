import { Router } from 'express';
import authRoutes from './auth.routes';
import userRoutes from './user.routes';
import sportRoutes from './sport.routes';
import competitionRoutes from './competition.routes';
import gameRoutes from './game.routes';
import marketRoutes from './market.routes';
import betRoutes from './bet.routes';
import walletRoutes from './wallet.routes';
import transferAccountRoutes from './transferAccount.routes';
import staticGamesRoutes from './staticGames.routes';
import fetchGamesRoutes from './fetchGames.routes';
import fundRequestRoutes from './fundRequest.routes';
import notificationRoutes from './notification.routes';
import settingsRoutes from './settings.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/sports', sportRoutes);
router.use('/competitions', competitionRoutes);
router.use('/games', gameRoutes);
router.use('/markets', marketRoutes);
router.use('/bets', betRoutes);
router.use('/wallet', walletRoutes);
router.use('/transfer-accounts', transferAccountRoutes);
router.use('/info', staticGamesRoutes);
router.use('/fetch-games', fetchGamesRoutes);
router.use('/funds', fundRequestRoutes);
router.use('/notifications', notificationRoutes);
router.use('/settings', settingsRoutes);

export default router;
