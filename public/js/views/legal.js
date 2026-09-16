// public/js/views/legal.js — Privacy Policy and Terms of Service.
//
// DRAFT PLACEHOLDERS: the copy below is a minimal, plain-language summary of
// what the site actually collects, written only so the pages exist before
// launch. It is NOT final legal text — the site owner must review and replace
// it with proper policy language before real users arrive. See
// docs/LAUNCH_CHECKLIST.md ("finalize legal copy").

import { esc } from '../utils.js';

const DRAFT_BANNER =
  `<div class="draft-banner" role="note">` +
    `<strong>Draft placeholder.</strong> This page summarizes the site's actual data practices ` +
    `in plain language, but it is not final legal text. The site owner will replace it with ` +
    `reviewed policy language before launch.` +
  `</div>`;

const PRIVACY_BODY =
  `<h2>What we collect</h2>` +
  `<ul>` +
    `<li><strong>Account:</strong> your email address, used only for passwordless sign-in (magic links). No passwords are stored.</li>` +
    `<li><strong>Your activity:</strong> votes, ratings, reviews, poll answers, hype, shelf placements, lists, and feedback you choose to submit.</li>` +
    `<li><strong>Cookies:</strong> a session cookie that keeps you signed in (30 days) and a theme-preference cookie (1 year). No advertising or cross-site tracking cookies.</li>` +
    `<li><strong>Analytics:</strong> privacy-friendly, cookieless page-view analytics (Cloudflare Web Analytics) — no fingerprinting.</li>` +
  `</ul>` +
  `<h2>What we don't do</h2>` +
  `<ul>` +
    `<li>We don't sell personal data.</li>` +
    `<li>We don't show third-party ads or share data with ad networks.</li>` +
  `</ul>` +
  `<h2>Content sources</h2>` +
  `<p>Book metadata and covers come from Open Library and Google Books; film/TV metadata and posters come from TMDB. Those services have their own privacy policies.</p>` +
  `<h2>Your data</h2>` +
  `<p>To correct or delete your account data, contact us via the <a href="/feedback">feedback page</a>.</p>`;

const TERMS_BODY =
  `<h2>Using the site</h2>` +
  `<ul>` +
    `<li>Novel Adaptations is a directory of books and their film/TV adaptations, with community features (votes, ratings, reviews, polls, lists).</li>` +
    `<li>You must be at least 13 years old to create an account.</li>` +
    `<li>Keep reviews and feedback lawful and respectful — no harassment, hate, spam, or copyrighted text beyond brief quotation.</li>` +
  `</ul>` +
  `<h2>Your content</h2>` +
  `<p>Reviews, lists, and feedback you post remain yours; you grant us a license to display them on the site. We may remove content that violates these terms.</p>` +
  `<h2>Accuracy</h2>` +
  `<p>Release dates, credits, and artwork come from third-party sources (TMDB, Open Library, Google Books) and community tips; we don't guarantee completeness or accuracy.</p>` +
  `<h2>Accounts</h2>` +
  `<p>Accounts are passwordless (email magic links). You're responsible for keeping your email account secure. We may suspend accounts that abuse the service.</p>`;

function legalView(title, kicker, body) {
  return {
    title,
    html:
      `<div class="page-narrow legal-page">` +
        `<p class="kicker">${esc(kicker)}</p>` +
        `<h1 class="display-title">${esc(title)}</h1>` +
        DRAFT_BANNER +
        body +
      `</div>`,
  };
}

export function privacyView() {
  return legalView('Privacy Policy', 'Legal', PRIVACY_BODY);
}

export function termsView() {
  return legalView('Terms of Service', 'Legal', TERMS_BODY);
}
