'use strict';
const db = require('./index');
const n = db.migrate((m) => console.log('migration:', m));
console.log(n ? `${n} migration(s) applied.` : 'Database is up to date.');
