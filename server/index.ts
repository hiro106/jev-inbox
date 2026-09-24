import path from 'node:path';
import { existsSync } from 'node:fs';
import { createApp } from './app';

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('PORT must be an integer between 1024 and 65535');
const staticDir = path.resolve('dist');
const app = createApp({
  port,
  apiKey: process.env.TYPESAFE_API_KEY,
  staticDir: existsSync(staticDir) ? staticDir : undefined,
});
const server = app.listen(port, '127.0.0.1', () =>
  console.log(`Jev Inbox API: http://127.0.0.1:${port}`),
);
server.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.close();
  });
