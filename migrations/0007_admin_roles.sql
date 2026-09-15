-- 0007_admin_roles.sql — admin flag on users (real owner auth, replaces the
-- CURATION_KEY shared-secret gate removed from src/news/curation.tsx).
--
-- Admin status is granted ONLY by the ADMIN_EMAILS env bootstrap in
-- GET /auth/verify (src/auth/routes.ts): on every successful sign-in, the
-- user's email is checked against ADMIN_EMAILS (comma-separated, trimmed,
-- case-insensitive) and is_admin is set to 1 on match. There is deliberately
-- NO demotion path in code — removing an email from ADMIN_EMAILS does not
-- revoke existing admins (revoke manually with
--   UPDATE users SET is_admin = 0 WHERE email = '…';).
-- No route, API, or UI may mutate is_admin.

ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
