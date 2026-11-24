'use strict';
const db = require('../db');
const { clientIp } = require('./util');

async function audit(req, action, entity = '', entityId = '', details = '') {
  try {
    (await db.prepare('INSERT INTO audit_logs (user_id, action, entity, entity_id, details, ip) VALUES (?,?,?,?,?,?)')
      .run(req?.user?.id ?? null, action, entity, String(entityId ?? ''), String(details).slice(0, 500), req ? clientIp(req) : null));
  } catch (e) { console.error('audit failed', e.message); }
}
module.exports = { audit };
