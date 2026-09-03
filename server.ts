import app from './src/app';
import config from './src/config';
import { startJobs } from './src/jobs/index.js';

const server = app.listen(config.port, config.host, () => {
  console.log(`Server running on ${config.host}:${config.port} in ${config.env} mode`);
  if (config.env !== 'test') {
    try {
      startJobs();
    } catch (e) {
      console.error('[jobs] failed to start', e);
    }
  }
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} already in use.`);
  } else {
    console.error('Server failed to start:', err.message);
  }
  process.exit(1);
});

const gracefulShutdown = (): void => {
  console.log('Shutting down gracefully...');
  server.close(() => process.exit(0));
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
