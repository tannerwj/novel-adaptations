// tests/e2e/run.mjs — single entry point for the E2E regression suite.
//
//   node tests/e2e/run.mjs [--base https://noveladaptations.com] [--skip-auth] [--only <name-substring>]
//
// Orchestrates: setup (mint test-user session via D1) → logged-out flows →
// logged-in flows → teardown (delete every test row), with teardown in a
// finally so it runs even when flows fail.
//
// --skip-auth runs only the logged-out flows (no CLOUDFLARE_API_TOKEN needed).
// Requires CLOUDFLARE_API_TOKEN otherwise (wrangler D1 for setup/teardown).

import { execFileSync } from 'node:child_process';
import { runTests, loadClientViews, setClientAuthed } from './helpers.mjs';
import { tests as loggedOutTests } from './flows/logged-out.mjs';
import { tests as loggedInTests } from './flows/logged-in.mjs';

const E2E_DIR = new URL('./', import.meta.url);

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { skipAuth: false, only: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--base' && args[i + 1]) process.env.BASE_URL = args[++i];
    else if (args[i] === '--skip-auth') opts.skipAuth = true;
    else if (args[i] === '--only' && args[i + 1]) opts.only = args[++i];
    else {
      console.error(`unknown arg: ${args[i]}`);
      process.exit(2);
    }
  }
  return opts;
}

function runNode(script, scriptArgs = []) {
  const out = execFileSync('node', [new URL(script, E2E_DIR).pathname, ...scriptArgs], {
    env: process.env,
    timeout: 180_000,
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 4 * 1024 * 1024,
  });
  return out.toString().trim();
}

const filter = (tests, only) => (only ? tests.filter((t) => t.name.toLowerCase().includes(only.toLowerCase())) : tests);

async function main() {
  const opts = parseArgs();
  const base = process.env.BASE_URL || 'https://noveladaptations.com';
  console.log(`E2E suite → ${base}${opts.only ? ` (only: "${opts.only}")` : ''}${opts.skipAuth ? ' [logged-out only]' : ''}`);

  let creds = null;
  let totals = { passed: 0, failed: [] };

  try {
    if (!opts.skipAuth) {
      console.log('\n## setup: minting test-user session');
      const json = runNode('setup.mjs');
      creds = JSON.parse(json);
      console.log(`  test user ${creds.email} (id ${creds.userId}) — session verified via /auth/me`);
    }

    const out = await runTests('logged-out flows', filter(loggedOutTests, opts.only), { base });
    totals.passed += out.passed;
    totals.failed.push(...out.failed.map((n) => `logged-out: ${n}`));

    if (creds && !opts.skipAuth) {
      const { store } = await loadClientViews({ base, session: creds.token });
      setClientAuthed(store, { id: creds.userId, email: creds.email });
      const loggedIn = await runTests(
        'logged-in flows',
        filter(loggedInTests, opts.only),
        { base, token: creds.token, userId: creds.userId, email: creds.email },
      );
      totals.passed += loggedIn.passed;
      totals.failed.push(...loggedIn.failed.map((n) => `logged-in: ${n}`));
    }
  } finally {
    if (creds) {
      console.log('\n## teardown: removing all test rows');
      try {
        runNode('teardown.mjs', [String(creds.userId)]);
        console.log(`  test user ${creds.userId} and all rows removed — verified zero leftovers`);
      } catch (e) {
        console.error(`  TEARDOWN FAILED: ${e.message}`);
        totals.failed.push('teardown: cleanup failed — inspect D1 for e2e-test@example.com rows');
      }
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULT: ${totals.passed} passed, ${totals.failed.length} failed`);
  for (const f of totals.failed) console.log(`  FAILED: ${f}`);
  process.exit(totals.failed.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`runner error: ${e.message}`);
  process.exit(1);
});
