'use strict';
const db = require('./index');
db.migrate((m) => console.log('migration:', m)).then((n) => {
  console.log(n ? `${n} migration(s) applied.` : 'Database is up to date.');
}).catch((e) => { console.error(e); process.exit(1); });
