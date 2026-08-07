/**
 * First-boot bootstrap: make sure there is exactly one way in.
 *
 * Creates the initial admin account if — and only if — no admin exists yet.
 * Idempotent, so it is safe on every start. Changing
 * DBK_BOOTSTRAP_ADMIN_PASSWORD later does nothing; use the app to change it.
 */

import { hashPassword } from './auth/password.js';
import { config } from './config.js';
import { metaPool } from './db/pools.js';

export interface BootstrapResult {
  created: boolean;
  username: string;
}

export async function ensureBootstrapAdmin(log: {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}): Promise<BootstrapResult> {
  const { rows } = await metaPool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM app_user WHERE role = 'admin' AND state <> 'deleted'`,
  );

  if ((rows[0]?.count ?? 0) > 0) {
    return { created: false, username: config.bootstrapAdmin.username };
  }

  const password = config.bootstrapAdmin.password;
  if (password === '') {
    throw new Error(
      'No admin account exists and DBK_BOOTSTRAP_ADMIN_PASSWORD is empty. ' +
        'Set it in .env and restart, otherwise nobody can log in.',
    );
  }
  if (password.length < 12) {
    throw new Error('DBK_BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters.');
  }

  const hash = await hashPassword(password);

  // ON CONFLICT guards the (unlikely) race of two instances booting together.
  const inserted = await metaPool.query<{ id: number }>(
    `INSERT INTO app_user (username, display_name, role, locale, password_hash, must_change_password)
     VALUES ($1, $2, 'admin', $3, $4, true)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      config.bootstrapAdmin.username,
      config.bootstrapAdmin.username,
      config.i18n.defaultLocale,
      hash,
    ],
  );

  if (inserted.rowCount === 0) {
    return { created: false, username: config.bootstrapAdmin.username };
  }

  await metaPool.query(
    `INSERT INTO audit_log (actor_id, action, target_type, target_id, detail)
     VALUES (NULL, 'bootstrap_admin_created', 'app_user', $1, '{"source":"env"}'::jsonb)`,
    [String(inserted.rows[0]?.id ?? '')],
  );

  log.warn(
    `Created initial admin "${config.bootstrapAdmin.username}". ` +
      `Log in, change the password, then blank DBK_BOOTSTRAP_ADMIN_PASSWORD in .env.`,
  );

  return { created: true, username: config.bootstrapAdmin.username };
}
