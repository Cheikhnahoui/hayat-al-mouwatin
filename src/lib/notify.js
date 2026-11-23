'use strict';
const db = require('../db');

const ins = () => db.prepare('INSERT INTO notifications (user_id, type, message_ar, message_fr, link) VALUES (?,?,?,?,?)');

function notifyUser(userId, type, ar, fr, link = '') {
  if (userId) ins().run(userId, type, ar, fr, link);
}
// notify all active users holding a permission (directly via role, or override), except `exceptId`
function notifyPermission(perm, type, ar, fr, link = '', exceptId = null) {
  const users = db.prepare(`
    SELECT DISTINCT u.id FROM users u
    JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
    LEFT JOIN role_permissions rp ON rp.role_id = r.id LEFT JOIN permissions p ON p.id = rp.permission_id
    WHERE u.is_active = 1 AND (r.key = 'super_admin' OR p.key = ?)`).all(perm);
  const st = ins();
  db.transaction(() => { for (const u of users) if (u.id !== exceptId) st.run(u.id, type, ar, fr, link); })();
}
module.exports = { notifyUser, notifyPermission };
