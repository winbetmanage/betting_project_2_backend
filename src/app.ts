import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import { authLimiter } from './middleware/rateLimiters';
import config from './config';
import routes from './routes';
import { notFound, errorHandler } from './middleware/error.middleware';

const app = express();

app.set('trust proxy', 1);
app.use(helmet());
app.use(
  cors({
    origin: config.env === 'production' ? config.corsOrigin : true,
    credentials: true,
  })
);
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting — login/register are limited. Token refresh and the public
// referral lookup are exempt (see skip() in rateLimiters.ts).
// Other endpoints are unlimited since proxied traffic shares one IP.
app.use('/api/v1/auth', authLimiter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (_req, res) => {
  res.json({ message: 'it is working' });
});

app.use('/api/v1', routes);

app.use(notFound);
app.use(errorHandler);

export default app;
