import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handler } from '../build/handler.js';
import { env } from '../build/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const certDir = process.env.XDG_CONFIG_HOME
  ? path.join(process.env.XDG_CONFIG_HOME, 'ai-dashboard')
  : path.join(process.env.HOME || '/root', '.config', 'ai-dashboard');

const certPath = path.join(certDir, 'cert.pem');
const keyPath = path.join(certDir, 'key.pem');

let cert, key;
try {
  cert = fs.readFileSync(certPath);
  key = fs.readFileSync(keyPath);
} catch (e) {
  console.error(`Failed to read certificates from ${certDir}:`, e.message);
  process.exit(1);
}

const server = https.createServer({ cert, key }, handler);

const port = env('PORT', '35001');

server.listen(port, '0.0.0.0', () => {
  console.log(`HTTPS server listening on https://0.0.0.0:${port}`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use`);
    process.exit(1);
  }
  console.error('Server error:', e);
});
