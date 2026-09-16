// tests/e2e/setup.mjs — mint a session for the dedicated E2E test user.
//
// Replicates the app's session creation (src/auth/routes.ts +
// src/auth/session.ts): sessions store SHA-256(token_hash), the raw token
// goes in the na_session cookie. The token format matches newToken()
// (32 random bytes → 64 hex chars).
//
// Prints JSON { userId, email, token } on stdout for run.mjs.
// Requires CLOUDFLARE_API_TOKEN in the environment (wrangler).
//
// SAFETY: only ever touches the e2e-test@example.com user. Refuses to
// continue if the resolved user id is 1 or 2 (known real accounts) or if
// the email doesn't match exactly.

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

export const TEST_EMAIL = 'e2e-test@example.com';
const PROTECTED_IDS = new Set([1, 2]);

const REPO_ROOT = new URL('../../', import.meta.url);
const BASE = (process.env.BASE_URL || 'https://noveladaptations.com').replace(/\/$/, '');

function d1(sql) {
  if (!process.env.CLOUDFLARE_API_TOKEN) {
    throw new Error('setup: CLOUDFLARE_API_TOKEN is required (wrangler D1 access)');
  }
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'novel-adaptations', '--remote', '--json', '--command', sql],
    { cwd: REPO_ROOT, env: process.env, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return JSON.parse(out.toString());
}

function resultRows(d1out, stmtIndex) {
  const r = d1out[stmtIndex];
  if (!r || !Array.isArray(r.results)) throw new Error(`setup: unexpected D1 output for statement ${stmtIndex}`);
  return r.results;
}

export async function setup() {
  // 1. Find-or-create the test user.
  const out = d1(
    `INSERT INTO users (email) VALUES ('${TEST_EMAIL}') ON CONFLICT(email) DO NOTHING; ` +
      `SELECT id, email, is_admin FROM users WHERE email = '${TEST_EMAIL}';`,
  );
  const rows = resultRows(out, 1);
  if (rows.length !== 1) throw new Error(`setup: expected exactly 1 test user, found ${rows.length}`);
  const user = rows[0];
  if (user.email !== TEST_EMAIL) throw new Error(`setup: email mismatch (${user.email}) — refusing to continue`);
  if (PROTECTED_IDS.has(user.id)) throw new Error(`setup: refusing to use protected user id ${user.id}`);
  if (user.is_admin !== 0) throw new Error(`setup: test user must not be an admin (id ${user.id})`);

  // 2. Drop any stale sessions, mint a fresh one (30-day TTL like the app).
  const token = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  d1(
    `DELETE FROM sessions WHERE user_id = ${user.id}; ` +
      `INSERT INTO sessions (user_id, token_hash, expires_at) ` +
      `VALUES (${user.id}, '${tokenHash}', datetime('now', '+30 days'));`,
  );

  // 3. Prove the session works end-to-end through the real auth path.
  const res = await fetch(`${BASE}/api/v1/auth/me`, {
    headers: { cookie: `na_session=${token}` },
  });
  if (res.status !== 200) throw new Error(`setup: /auth/me returned ${res.status} with fresh session`);
  const me = await res.json();
  if (me?.user?.email !== TEST_EMAIL || me?.user?.id !== user.id) {
    throw new Error('setup: /auth/me did not return the test user');
  }

  return { userId: user.id, email: TEST_EMAIL, token };
}

// When run directly: print the credentials JSON for run.mjs to consume.
import { resolve } from 'node:path';
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  setup()
    .then((creds) => {
      console.log(JSON.stringify(creds));
    })
    .catch((e) => {
      console.error(`setup failed: ${e.message}`);
      process.exit(1);
    });
}
