'use strict';
// Secure creation of the first (or an additional) Super Admin. No credentials are ever hardcoded.
//   Interactive:  npm run create-admin
//   Non-interactive (CI / Docker): ADMIN_USERNAME=... ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run create-admin
const readline = require('readline');
const db = require('../src/db');
const { seed } = require('../src/db/seed');
const { hashPassword, checkPasswordPolicy } = require('../src/lib/auth');

function ask(q, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); else rl.output.write(''); };
    }
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim()); });
  });
}

(async () => {
  (await seed());
  const e = process.env;
  const username = e.ADMIN_USERNAME || (await ask('Username: '));
  const email = e.ADMIN_EMAIL || (await ask('Email: '));
  const name = e.ADMIN_NAME || (await ask('Display name: '));
  let password = e.ADMIN_PASSWORD;
  if (!password) {
    password = await ask('Password (min 10 chars, letters + digits): ', true);
    const again = await ask('Repeat password: ', true);
    if (password !== again) { console.error('Passwords do not match.'); process.exit(1); }
  }
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) { console.error('Invalid username (3-32 chars: letters, digits, _ . -).'); process.exit(1); }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { console.error('Invalid email.'); process.exit(1); }
  if (checkPasswordPolicy(password)) { console.error('Password too weak: use at least 10 characters with letters and digits.'); process.exit(1); }
  if ((await db.prepare('SELECT 1 FROM users WHERE lower(username) = lower(?) OR lower(email) = lower(?)').get(username, email))) { console.error('A user with this username or email already exists.'); process.exit(1); }

  const id = (await db.prepare('INSERT INTO users (username, email, password_hash, name_ar, name_fr) VALUES (?,?,?,?,?)').run(username, email, hashPassword(password), name, name)).lastInsertRowid;
  (await db.prepare("INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE key = 'super_admin'").run(id));
  (await db.prepare("INSERT INTO audit_logs (user_id, action, entity, entity_id, details) VALUES (?, 'user.create_super_admin', 'user', ?, 'created via CLI')").run(id, String(id)));
  console.log(`Super Admin "${username}" created. Log in at /admin`);
})();
