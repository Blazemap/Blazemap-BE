import { createApp } from './app.js';
import { disconnect, env } from './config/index.js';
export { createApp } from './app.js';

const server = createApp().listen(env.PORT);
server.requestTimeout = 120000;
server.headersTimeout = 15000;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.close(() => { void disconnect().then(() => process.exit(0)); });
  setTimeout(() => process.exit(1), 15000).unref();
});
