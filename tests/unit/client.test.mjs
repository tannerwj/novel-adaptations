// tests/unit/client.test.mjs — DOM regression tests for client-side fixes:
//
//  - finding 18: review drafts and listeners survive "Load more reviews"
//  - finding 19: a failed logout keeps the session and shows a retry error
//  - finding 20: missing pages render not-found markup (not empty HTML)
//  - finding 21: list reorder rebuilds DOM order in both directions
//
// Uses happy-dom (devDependency) for a real DOM; global fetch is stubbed
// per test because api.js reads it at call time.
//
// Run: node --test "tests/unit/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

const realFetch = globalThis.fetch;

function setupDom(url = 'https://noveladaptations.com/') {
  const window = new Window({ url });
  for (const key of [
    'window', 'document', 'navigator', 'history', 'location',
    'Event', 'CustomEvent', 'FormData', 'HTMLElement', 'Element',
    'Node', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame',
  ]) {
    if (window[key] === undefined) continue;
    // Node 24 ships some globals (e.g. navigator) as getter-only: define
    // instead of assigning.
    Object.defineProperty(globalThis, key, {
      value: window[key],
      configurable: true,
      writable: true,
    });
  }
  globalThis.document = window.document;
  globalThis.window = window;
  return window;
}

function stubFetch(handler) {
  globalThis.fetch = handler;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}

const jsonRes = (status, data) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
});

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// Modules are imported once, after the first DOM exists (they only touch
// the DOM inside functions).
setupDom();
const { applyItemOrder } = await import('../../public/js/views/lists.js');
const { reviewsSection, wireReviews } = await import('../../public/js/widgets.js');
const { notFoundHtml, errorHtml } = await import('../../public/js/router.js');
const { adaptationView, bookView, watchView } = await import('../../public/js/views/detail.js');
const { mountChrome, refreshChrome } = await import('../../public/js/components.js');
const { store } = await import('../../public/js/store.js');

// --- finding 21 -------------------------------------------------------------

test('applyItemOrder rebuilds DOM order for upward moves', async () => {
  setupDom();
  document.body.innerHTML =
    `<div id="root">` +
    [1, 2, 3, 4].map((i) => `<div data-item-row="${i}"><span class="pos">${i}</span></div>`).join('') +
    `</div>`;
  const root = document.getElementById('root');

  // Move item 3 up one: [1,2,3,4] -> [1,3,2,4].
  applyItemOrder(root, [1, 3, 2, 4]);
  assert.deepEqual(
    [...root.querySelectorAll('[data-item-row]')].map((r) => Number(r.dataset.itemRow)),
    [1, 3, 2, 4],
  );
  assert.deepEqual(
    [...root.querySelectorAll('[data-item-row] .pos')].map((p) => p.textContent),
    ['1', '2', '3', '4'],
  );

  // Consecutive upward move derives from the NEW order: move 4 to the top.
  applyItemOrder(root, [4, 1, 3, 2]);
  assert.deepEqual(
    [...root.querySelectorAll('[data-item-row]')].map((r) => Number(r.dataset.itemRow)),
    [4, 1, 3, 2],
  );
  assert.deepEqual(
    [...root.querySelectorAll('[data-item-row] .pos')].map((p) => p.textContent),
    ['1', '2', '3', '4'],
  );
});

test('applyItemOrder handles downward moves and missing ids', async () => {
  setupDom();
  document.body.innerHTML =
    `<div id="root">` +
    [1, 2, 3].map((i) => `<div data-item-row="${i}"><span class="pos">${i}</span></div>`).join('') +
    `</div>`;
  const root = document.getElementById('root');
  applyItemOrder(root, [2, 3, 1]);
  assert.deepEqual(
    [...root.querySelectorAll('[data-item-row]')].map((r) => Number(r.dataset.itemRow)),
    [2, 3, 1],
  );
  // Unknown ids in the order array are ignored, not crashed on.
  applyItemOrder(root, [3, 999, 2, 1]);
  assert.deepEqual(
    [...root.querySelectorAll('[data-item-row]')].map((r) => Number(r.dataset.itemRow)),
    [3, 2, 1],
  );
});

// --- finding 20 ---------------------------------------------------------------

test('notFoundHtml renders a real not-found page', async () => {
  const html = notFoundHtml();
  assert.ok(html.includes('Page not found'));
  assert.ok(!html.match(/^\s*$/), 'must not be empty HTML');
  const err = errorHtml('Oops', 'Something broke', 'Try again later.');
  assert.ok(err.includes('Something broke') && err.includes('Try again later.'));
});

test('detail views return not-found markup for missing records', async () => {
  setupDom();
  stubFetch(async () => jsonRes(404, { error: { code: 'not_found', message: 'nope' } }));
  try {
    for (const view of [adaptationView, bookView, watchView]) {
      const res = await view({ params: { slug: 'no-such-thing' } });
      assert.equal(res.title, 'Not found');
      assert.ok(res.html.includes('Page not found'), 'renders not-found markup, not empty HTML');
    }
    // Empty slug short-circuits without any fetch.
    const res = await bookView({ params: { slug: '' } });
    assert.equal(res.title, 'Not found');
  } finally {
    restoreFetch();
  }
});

// --- finding 18 ---------------------------------------------------------------

function reviewJson(id, page) {
  return {
    id,
    title: `Review ${id}`,
    body: `Body ${id} — no spoilers here.`,
    has_spoilers: id % 3 === 0, // every third review is spoiler-flagged
    author_id: 99,
    author_name: 'Someone',
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
  };
}

test('review draft and listeners survive "Load more reviews"', async () => {
  setupDom();
  store.user = { id: 1, email: 'me@example.com', is_admin: 0 };
  document.body.innerHTML = reviewsSection('book', 42);

  const pages = {
    1: Array.from({ length: 10 }, (_, i) => reviewJson(i + 1)),
    2: Array.from({ length: 10 }, (_, i) => reviewJson(i + 11)),
  };
  stubFetch(async (url) => {
    const page = Number(new URL(url, 'https://x.test').searchParams.get('page') || '1');
    return jsonRes(200, {
      reviews: { data: pages[page] ?? [], total: 25, page, per_page: 10 },
    });
  });
  try {
    wireReviews(document.body);
    await tick(50);

    // Page 1 rendered, form rendered once.
    assert.equal(document.querySelectorAll('[data-review-id]').length, 10);
    const form = document.querySelector('form[data-review-form]');
    assert.ok(form, 'write-review form rendered for signed-in user');

    // Type a draft.
    const draft = 'My half-finished thoughts on this book…';
    form.querySelector('textarea[name="body"]').value = draft;

    // Grab a spoiler toggle from page 1 and confirm its listener works
    // BEFORE pagination (baseline).
    const toggle = document.querySelector('[data-spoiler-toggle]');
    assert.ok(toggle, 'page 1 has a spoiler toggle');
    const body = toggle.closest('.spoiler-wrap').querySelector('.review-body');
    toggle.click();
    assert.ok(!body.classList.contains('spoiler-blurred'), 'toggle reveals (baseline)');

    // Load more (page 2, append).
    document.querySelector('[data-reviews-more-btn]').click();
    await tick(50);

    assert.equal(document.querySelectorAll('[data-review-id]').length, 20);

    // The draft survived: the form element is the same node, value intact.
    const formAfter = document.querySelector('form[data-review-form]');
    assert.equal(formAfter, form, 'form was not re-rendered');
    assert.equal(
      formAfter.querySelector('textarea[name="body"]').value,
      draft,
      'draft text preserved across pagination',
    );

    // The page-1 spoiler toggle still works — its listener wasn't destroyed
    // by an innerHTML re-serialization (the finding-18 regression).
    const toggleAfter = document.querySelector('[data-spoiler-toggle]');
    assert.equal(toggleAfter, toggle, 'page-1 toggle node identity preserved');
    toggleAfter.click(); // was revealed; clicking again re-blurs
    assert.ok(body.classList.contains('spoiler-blurred'), 'page-1 listener still wired after append');
  } finally {
    restoreFetch();
    store.user = null;
  }
});

// --- finding 19 ---------------------------------------------------------------

test('failed logout keeps the session and shows a retryable error', async () => {
  setupDom();
  document.body.innerHTML = '<div id="app"></div>';
  store.user = { id: 7, email: 'me@example.com', is_admin: 0 };
  let logoutShouldFail = true;
  stubFetch(async (url) => {
    if (String(url).includes('/api/v1/auth/logout')) {
      return logoutShouldFail
        ? jsonRes(500, { error: { code: 'boom', message: 'server exploded' } })
        : jsonRes(200, {});
    }
    return jsonRes(200, {});
  });
  try {
    mountChrome();
    const btn = document.querySelector('[data-logout]');
    assert.ok(btn, 'header renders a logout button when signed in');

    btn.click();
    await tick(50);

    assert.ok(store.user, 'session retained after failed logout');
    assert.equal(store.user.id, 7);
    const err = document.querySelector('[data-logout-error]');
    assert.ok(err, 'retryable inline error shown');
    assert.ok(err.textContent.includes('try again'));

    // Retry with the server healthy: logout completes.
    logoutShouldFail = false;
    // Re-query: a failed logout leaves the button in place.
    document.querySelector('[data-logout]').click();
    await tick(50);
    assert.equal(store.user, null, 'session cleared after confirmed logout');
    assert.equal(document.querySelector('[data-logout-error]'), null, 'error cleared on success');
  } finally {
    restoreFetch();
    store.user = null;
  }
});
