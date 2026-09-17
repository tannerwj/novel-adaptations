/**
 * src/auth/rate_limit.ts — magic-link sending budgets (pure D1, no imports).
 *
 * Three hourly budgets guard the public magic-link endpoints:
 *
 * - per email:  5/hour   — stops one address being email-bombed
 * - per IP:    20/hour   — stops a single source burning the mail budget
 * - global:   500/hour   — backstop against distributed fan-out abuse
 *
 * Atomicity: the entire check-and-claim is ONE D1 statement — an
 * INSERT ... SELECT ... WHERE whose WHERE counts the current hour's
 * claims at all three tiers. D1 executes a statement atomically, so the
 * guard and the write are indivisible: an allowed request inserts exactly
 * one claim row, a denied request inserts nothing, and concurrent requests
 * serialize on the statement. There is no read-then-write race and no
 * partial consumption (a denial can never burn the IP or global budget).
 *
 * This replaced a check-then-increment counter design (finding 7): two
 * concurrent requests could both read 4/5 and both increment to 6/5, and
 * a lost race between the read batch and the increment batch could burn
 * one tier's budget while denying on another.
 *
 * Kept import-free so the budget logic is unit-testable without the route
 * modules' UI graph.
 */

const MAGIC_LINK_HOURLY_LIMIT = 5;
const MAGIC_LINK_IP_HOURLY_LIMIT = 20;
const MAGIC_LINK_GLOBAL_HOURLY_LIMIT = 500;

/**
 * All three magic-link sending budgets. False when ANY budget is exceeded —
 * callers must not reveal which one tripped. Denied calls write nothing.
 */
export async function checkMagicLinkRate(
  db: D1Database,
  email: string,
  ip: string,
): Promise<boolean> {
  const hour = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH (UTC)

  // Single atomic statement: insert the claim row only when every tier is
  // under its cap. meta.changes is 1 on allow, 0 on deny.
  const claimed = await db
    .prepare(
      `INSERT INTO magic_link_claims (hour, ip, email)
       SELECT ?1, ?2, ?3
        WHERE (SELECT COUNT(*) FROM magic_link_claims WHERE hour = ?1) < ?4
          AND (SELECT COUNT(*) FROM magic_link_claims WHERE hour = ?1 AND ip = ?2) < ?5
          AND (SELECT COUNT(*) FROM magic_link_claims WHERE hour = ?1 AND email = ?3) < ?6`,
    )
    .bind(
      hour,
      ip,
      email,
      MAGIC_LINK_GLOBAL_HOURLY_LIMIT,
      MAGIC_LINK_IP_HOURLY_LIMIT,
      MAGIC_LINK_HOURLY_LIMIT,
    )
    .run();

  // Best-effort prune of older hour buckets; keeps the table at roughly
  // one hour of sends. Independent of the claim above — correctness never
  // depends on it. (Hour buckets sort lexicographically = chronologically.)
  await db
    .prepare('DELETE FROM magic_link_claims WHERE hour < ?1')
    .bind(hour)
    .run();

  return claimed.meta.changes === 1;
}
