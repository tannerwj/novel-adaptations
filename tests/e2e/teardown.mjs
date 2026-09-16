// tests/e2e/teardown.mjs — remove every row the E2E suite created.
//
// Deletes, in dependency-safe order, all votes, shelf items, ratings,
// reviews, poll votes, lists (+items), feedback, rate-limit rows, sessions,
// and finally the test user itself. Then SELECTs every table back to prove
// zero rows remain.
//
// SAFETY: resolves the user by id, then REFUSES to delete unless the row's
// email is exactly e2e-test@example.com, is_admin = 0, and id is not 1 or 2.
// Usage: node teardown.mjs <userId>   (or E2E_USER_ID env)

import { execFileSync } from 'node:child_process';
import { TEST_EMAIL } from './setup.mjs';

const REPO_ROOT = new URL('../../', import.meta.url);

function d1(sql) {
  if (!process.env.CLOUDFLARE_API_TOKEN) {
    throw new Error('teardown: CLOUDFLARE_API_TOKEN is required (wrangler D1 access)');
  }
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'novel-adaptations', '--remote', '--json', '--command', sql],
    { cwd: REPO_ROOT, env: process.env, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return JSON.parse(out.toString());
}

const TABLES = [
  'votes',
  'shelf_items',
  'ratings',
  'reviews',
  'poll_votes',
  'hype',
  'lists',
  'feedback',
  'vote_rate',
  'ratings_rate',
  'reviews_rate',
  'polls_rate',
  'hype_rate',
  'lists_rate',
  'sessions',
];

export async function teardown(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id < 1) throw new Error(`teardown: bad user id ${userId}`);

  // Safety gate: resolve the row and check it is really the test user.
  const check = d1(`SELECT id, email, is_admin FROM users WHERE id = ${id};`);
  const rows = check[0]?.results ?? [];
  if (rows.length !== 1) throw new Error(`teardown: user id ${id} not found — refusing to delete`);
  const u = rows[0];
  if (u.email !== TEST_EMAIL) throw new Error(`teardown: email is ${u.email}, not the test user — refusing to delete`);
  if (u.is_admin !== 0) throw new Error(`teardown: user ${id} is an admin — refusing to delete`);
  if (id === 1 || id === 2) throw new Error(`teardown: refusing to delete protected user id ${id}`);

  // list_items references lists; delete them first.
  const deletes = [
    `DELETE FROM list_items WHERE list_id IN (SELECT id FROM lists WHERE user_id = ${id})`,
    ...TABLES.map((t) => `DELETE FROM ${t} WHERE ${t === 'users' ? 'id' : 'user_id'} = ${id}`),
    `DELETE FROM users WHERE id = ${id}`,
  ];
  d1(deletes.join('; '));

  // Verify: every table must be back to zero rows for this user.
  const verifySql = TABLES.map(
    (t) => `SELECT COUNT(*) AS n FROM ${t} WHERE ${t === 'users' ? 'id' : 'user_id'} = ${id}`,
  ).join('; ');
  const verify = d1(verifySql + `; SELECT COUNT(*) AS n FROM users WHERE id = ${id}; SELECT COUNT(*) AS n FROM list_items WHERE list_id IN (SELECT id FROM lists WHERE user_id = ${id});`);
  const counts = {};
  [...TABLES, 'users', 'list_items'].forEach((t, i) => {
    counts[t] = verify[i]?.results?.[0]?.n ?? '?';
  });
  const leftover = Object.entries(counts).filter(([, n]) => n !== 0);
  if (leftover.length > 0) {
    throw new Error(`teardown: leftover rows: ${leftover.map(([t, n]) => `${t}=${n}`).join(', ')}`);
  }
  return { userId: id, deleted: true };
}

import { resolve } from 'node:path';
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const userId = process.argv[2] || process.env.E2E_USER_ID;
  teardown(userId)
    .then((r) => console.log(`teardown complete: test user ${r.userId} and all rows removed`))
    .catch((e) => {
      console.error(`teardown failed: ${e.message}`);
      process.exit(1);
    });
}
