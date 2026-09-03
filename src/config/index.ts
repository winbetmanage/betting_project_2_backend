import dotenv from 'dotenv';

dotenv.config();

export interface AppConfig {
  env: string;
  port: number;
  host: string;
  jwtSecret: string;
  accessTokenExpiresIn: string;
  refreshTokenSecret: string;
  refreshTokenExpiresIn: string;
  corsOrigin: string[];
  bcryptRounds: number;
}

const config: AppConfig = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  jwtSecret: process.env.JWT_SECRET || 'default_secret',
  accessTokenExpiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || '15m',
  refreshTokenSecret: process.env.REFRESH_TOKEN_SECRET || 'default_refresh_secret',
  refreshTokenExpiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || '7d',
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:4000')
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean),
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '10', 10),
};

export default config;
