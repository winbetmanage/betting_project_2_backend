const express = require('express');

const app = express();
app.set('trust proxy', 1);

const port = parseInt(process.env.PORT, 10) || 3000;
const host = process.env.HOST || '0.0.0.0';

app.get('/', (req, res) => res.json({ message: 'Hello World' }));
app.get('/hello', (req, res) => res.json({ greeting: 'Hello', to: 'World' }));
app.get('/api/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.get('/api/v1/ping', (req, res) => res.json({ ping: 'pong' }));
app.get('/status', (req, res) => res.json({ running: true, time: new Date().toISOString() }));

const server = app.listen(port, host, () => {
  console.log(`hello.js running on ${host}:${port}`);
});

server.on('error', (err) => {
  console.error('Server failed to start:', err.message);
  process.exit(1);
});