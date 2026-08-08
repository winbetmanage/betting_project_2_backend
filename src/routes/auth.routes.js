const { Router } = require('express');
const authController = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');

const router = Router();

router.post('/register', validate({
  email: { required: true, type: 'email' },
  password: { required: true, min: 6 },
  name: { required: true, maxLength: 100 },
}), authController.register);

router.post('/login', validate({
  email: { required: true, type: 'email' },
  password: { required: true },
}), authController.login);

router.post('/refresh', validate({
  refreshToken: { required: true },
}), authController.refresh);

router.post('/logout', validate({
  refreshToken: { required: true },
}), authController.logout);

router.post('/logout-all', authenticate, authController.logoutAll);

module.exports = router;
