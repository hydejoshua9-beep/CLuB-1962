'use strict';
const { openDb } = require('./db');
const { createApp, seed } = require('./app');

(async () => {
  const db = await openDb();
  await seed(db);
  const app = createApp(db, { forceHttps: process.env.NODE_ENV === 'production' });
  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, () => console.log('Club 1962 HQ running on port ' + port + ' (' + db.kind + ' database)'));
  const stop = () => { server.close(() => db.close().finally(() => process.exit(0))); server.closeAllConnections(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
})().catch(e => { console.error(e); process.exit(1); });
