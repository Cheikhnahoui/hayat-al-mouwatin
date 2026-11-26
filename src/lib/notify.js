'use strict';
const db = require('../db');

const INSERT = 'INSERT INTO notifications (user_id, type, message_ar, message_fr, link) VALUES (?,?,?,?,?)';

async function notifyUser(userId, type, ar, fr, link = '') {
  if (userId) await db.prepare(INSERT).run(userId, type, ar, fr, link);
}
// notify all active users holding a permission, except `exceptId`. Same rules as auth.permissionsFor():
// super admins always; otherwise a granted per-user override, or a role permission that is not revoked by an override.
async function notifyPermission(perm, type, ar, fr, link = '', exceptId = null) {
  const users = await db.prepare(`
    SELECT u.id FROM users u WHERE u.is_active = 1 AND (
      EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.key = 'super_admin')
      OR EXISTS (SELECT 1 FROM user_permissions up JOIN permissions p ON p.id = up.permission_id WHERE up.user_id = u.id AND p.key = @perm AND up.granted = 1)
      OR (
        EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id JOIN permissions p ON p.id = rp.permission_id WHERE ur.user_id = u.id AND p.key = @perm)
        AND NOT EXISTS (SELECT 1 FROM user_permissions up JOIN permissions p ON p.id = up.permission_id WHERE up.user_id = u.id AND p.key = @perm AND up.granted = 0)
      ))`).all({ perm });
  await db.transaction(async () => {
    for (const u of users) if (u.id !== exceptId) await db.prepare(INSERT).run(u.id, type, ar, fr, link);
  })();
}
module.exports = { notifyUser, notifyPermission };
