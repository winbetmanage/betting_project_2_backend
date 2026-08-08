const { Router } = require('express');
const authRoutes = require('./auth.routes');
const userRoutes = require('./user.routes');
const sportRoutes = require('./sport.routes');
const competitionRoutes = require('./competition.routes');
const gameRoutes = require('./game.routes');
const marketRoutes = require('./market.routes');
const betRoutes = require('./bet.routes');
const walletRoutes = require('./wallet.routes');

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/sports', sportRoutes);
router.use('/competitions', competitionRoutes);
router.use('/games', gameRoutes);
router.use('/markets', marketRoutes);
router.use('/bets', betRoutes);
router.use('/wallet', walletRoutes);

module.exports = router;