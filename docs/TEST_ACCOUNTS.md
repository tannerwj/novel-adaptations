# Seed personas — fictional test accounts. REMOVE BEFORE LAUNCH.

These six accounts are **fictional seed data** created on 2026-09-16 to make
logged-in flows testable against lifelike data while the site has no real
users. All emails use `@example.com` (reserved, non-deliverable) so they can
never belong to a real person. None are admins.

**Delete all of these (and their rows) before the site launches to real users.**
See "Purge SQL" below.

| D1 user id | Display name (email local part) | Email | Taste profile |
|---|---|---|---|
| 4 | maya.okafor | maya.okafor@example.com | Fantasy superfan (LOTR, Potter, Witcher) |
| 5 | eleanor.vance | eleanor.vance@example.com | Classics professor type (Austen, Shelley, Stoker) |
| 6 | marc.delgado | marc.delgado@example.com | Horror buff (King, Hill House, Dracula) |
| 7 | priya.raman | priya.raman@example.com | Casual rom-com / comfort watcher |
| 8 | tom.becker | tom.becker@example.com | Sci-fi nerd (Dune, The Martian) |
| 9 | sofia.marchetti | sofia.marchetti@example.com | Prestige-TV devotee (Queen's Gambit, Big Little Lies) |

Seeded activity (per persona): 5–6 star ratings, 1–2 written reviews (some
spoiler-flagged), 1–3 Most Wanted votes, 2–3 poll votes, 4 shelf entries.
Personas 4–7 each own one public list (4 lists, 22 items total).
`created_at` timestamps are spread over 2026-08-26 → 2026-09-15 to look organic.

Public lists:
- `cozy-fantasy-rainy-weekends` — "Cozy Fantasy Adaptations for Rainy Weekends" (maya)
- `the-book-was-better` — "The Book Was Better: Films That Prove It" (eleanor)
- `horror-done-right` — "Horror Done Right" (marc)
- `feel-good-friday-night` — "Feel-Good Friday Night Watches" (priya)

## Purge SQL

Run against production D1 before launch. The purge set is derived from
**emails, never bare ids**: every DELETE below reuses the same
email-guarded subquery, so if the id list ever goes stale and identifies
different accounts, their activity is left untouched (their emails won't
match) instead of being deleted while their accounts survive.

```sql
-- 0. Snapshot the purge set first (sanity check). Expect exactly the six
--    seed personas plus the automated e2e-test@example.com suite account
--    (also @example.com, also test-only). If anything else appears, STOP.
SELECT id, email, is_admin FROM users
 WHERE email LIKE '%@example.com' AND is_admin = 0 AND id NOT IN (1, 2);

-- 1. Delete dependent rows. Each statement re-derives the user set from
--    the email guard — do NOT replace these subqueries with a bare id list.
DELETE FROM votes        WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@example.com' AND is_admin = 0 AND id NOT IN (1, 2));
DELETE FROM ratings      WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@example.com' AND is_admin = 0 AND id NOT IN (1, 2));
DELETE FROM reviews      WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@example.com' AND is_admin = 0 AND id NOT IN (1, 2));
DELETE FROM poll_votes   WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@example.com' AND is_admin = 0 AND id NOT IN (1, 2));
DELETE FROM hype         WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@example.com' AND is_admin = 0 AND id NOT IN (1, 2));
DELETE FROM list_items   WHERE list_id IN (SELECT id FROM lists WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@example.com' AND is_admin = 0 AND id NOT IN (1, 2)));
DELETE FROM lists        WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@example.com' AND is_admin = 0 AND id NOT IN (1, 2));
DELETE FROM shelf_items  WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@example.com' AND is_admin = 0 AND id NOT IN (1, 2));
DELETE FROM feedback     WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@example.com' AND is_admin = 0 AND id NOT IN (1, 2));
DELETE FROM sessions     WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@example.com' AND is_admin = 0 AND id NOT IN (1, 2));
DELETE FROM magic_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@example.com' AND is_admin = 0 AND id NOT IN (1, 2));
DELETE FROM vote_rate    WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@example.com' AND is_admin = 0 AND id NOT IN (1, 2));
DELETE FROM ratings_rate WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@example.com' AND is_admin = 0 AND id NOT IN (1, 2));
DELETE FROM reviews_rate WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@example.com' AND is_admin = 0 AND id NOT IN (1, 2));
DELETE FROM polls_rate   WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@example.com' AND is_admin = 0 AND id NOT IN (1, 2));
DELETE FROM hype_rate    WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@example.com' AND is_admin = 0 AND id NOT IN (1, 2));
DELETE FROM lists_rate   WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@example.com' AND is_admin = 0 AND id NOT IN (1, 2));

-- 2. Delete the users themselves (guard: example.com only, never admins,
--    never ids 1/2):
DELETE FROM users WHERE email LIKE '%@example.com' AND is_admin = 0 AND id NOT IN (1, 2);

-- 3. Verify zero remain:
SELECT COUNT(*) FROM users WHERE email LIKE '%@example.com';
```

Run the statements as one D1 batch so the cleanup is atomic (a batch
rolls back entirely if any statement fails) rather than statement by
statement.

Do NOT purge: user id 1, user id 2 (owner admin), or any non-`@example.com`
address.
