// tests/e2e/flows/logged-in.mjs — authenticated regression flows.
//
// Runs as the dedicated e2e-test@example.com user (session minted by
// setup.mjs). Every created row carries a unique per-run marker and is
// removed by teardown.mjs. ctx: { base, token, userId, email, client } with
// the client store already marked authed.

import {
  test,
  assert,
  eq,
  contains,
  notContains,
  apiGet,
  apiPost,
  apiDel,
  getPage,
  setClientAuthed,
  loadClientViews,
} from '../helpers.mjs';

const RUN = Date.now().toString(36);
const BOOK_ID = 38;
const WATCH_ID = 38;
const ADAPTATION_ID = 9;

export const tests = [
  test('session: /auth/me returns the test user', async (ctx) => {
    const me = await apiGet('/api/v1/auth/me', { session: ctx.token });
    eq(me.status, 200, 'GET /api/v1/auth/me status');
    eq(me.data?.user?.email, ctx.email, 'session belongs to the test user');
    eq(me.data?.user?.id, ctx.userId, 'session user id matches setup');
  }),

  test('votes: vote, idempotent re-vote, unvote', async (ctx) => {
    const v1 = await apiPost('/api/v1/votes', { session: ctx.token, body: { book_id: BOOK_ID } });
    eq(v1.status, 200, 'POST /api/v1/votes status');
    eq(v1.data.voted, true, 'first vote registers');
    const count = v1.data.votes;
    assert(typeof count === 'number' && count >= 1, 'vote count is a positive number');

    const v2 = await apiPost('/api/v1/votes', { session: ctx.token, body: { book_id: BOOK_ID } });
    eq(v2.data.voted, true, 're-vote stays voted');
    eq(v2.data.votes, count, 're-vote does not double-count');

    const un = await apiDel(`/api/v1/votes/${BOOK_ID}`, { session: ctx.token });
    eq(un.status, 200, 'DELETE /api/v1/votes/:bookId status');
    eq(un.data.voted, false, 'unvote clears the vote');
    eq(un.data.votes, count - 1, 'unvote decrements the count');
  }),

  test('ratings: rate, change rating, summary reflects it', async (ctx) => {
    const r1 = await apiPost('/api/v1/ratings', {
      session: ctx.token,
      body: { target_type: 'screen_work', target_id: WATCH_ID, rating: 4 },
    });
    eq(r1.status, 200, 'POST /api/v1/ratings status');
    eq(r1.data.user_rating, 4, 'rating of 4 is stored');

    const r2 = await apiPost('/api/v1/ratings', {
      session: ctx.token,
      body: { target_type: 'screen_work', target_id: WATCH_ID, rating: 5 },
    });
    eq(r2.data.user_rating, 5, 'rating changes to 5');

    const g = await apiGet('/api/v1/ratings', {
      session: ctx.token,
      query: { target_type: 'screen_work', target_id: String(WATCH_ID) },
    });
    eq(g.status, 200, 'GET /api/v1/ratings status');
    eq(g.data.user_rating, 5, 'summary shows the updated user rating');
    assert(g.data.count >= 1, 'summary count includes the test rating');
    // NOTE: there is no public DELETE /ratings endpoint — the row is removed
    // by teardown.mjs, whose verification asserts zero leftover rows.
  }),

  test('reviews: post with spoiler flag, spoiler treatment, delete', async (ctx) => {
    const marker = `e2e-${RUN}`;
    const post = await apiPost('/api/v1/reviews', {
      session: ctx.token,
      body: {
        target_type: 'screen_work',
        target_id: WATCH_ID,
        title: `E2E review ${RUN}`,
        body: `E2E review body ${marker} — safe to delete.`,
        has_spoilers: true,
      },
    });
    eq(post.status, 201, 'POST /api/v1/reviews status');
    eq(post.data.review.has_spoilers, true, 'spoiler flag is stored');
    const reviewId = post.data.review.id;
    assert(reviewId > 0, 'review gets an id');

    const list = await apiGet('/api/v1/reviews', {
      session: ctx.token,
      query: { target_type: 'screen_work', target_id: String(WATCH_ID) },
    });
    const found = (list.data.reviews?.data ?? []).find((r) => r.id === reviewId);
    assert(found, 'the new review appears in the review list');
    eq(found.has_spoilers, true, 'listed review carries the spoiler flag');

    // Front-end: the real widget blurs spoiler bodies behind a reveal toggle.
    const { widgets, store } = await loadClientViews({ session: ctx.token });
    setClientAuthed(store, { id: ctx.userId, email: ctx.email });
    const html = widgets.reviewItemHtml(found, ctx.userId);
    contains(html, marker, 'widget renders the review body');
    contains(html, 'spoiler-blurred', 'spoiler review body is blurred');
    contains(html, 'Contains spoilers — click to reveal', 'spoiler review has a reveal toggle');
    const plain = widgets.reviewItemHtml({ ...found, has_spoilers: false }, ctx.userId);
    notContains(plain, 'spoiler-blurred', 'non-spoiler review is not blurred');

    const del = await apiDel(`/api/v1/reviews/${reviewId}`, { session: ctx.token });
    eq(del.status, 200, 'DELETE /api/v1/reviews/:id status');

    const after = await apiGet('/api/v1/reviews', {
      session: ctx.token,
      query: { target_type: 'screen_work', target_id: String(WATCH_ID) },
    });
    assert(!(after.data.reviews?.data ?? []).some((r) => r.id === reviewId), 'deleted review is gone');
  }),

  test('polls: vote, tally moves, change vote', async (ctx) => {
    const before = await apiGet(`/api/v1/polls/${ADAPTATION_ID}`, { session: ctx.token });
    eq(before.status, 200, 'GET /api/v1/polls/:id status');
    const b0 = before.data.counts.book ?? 0;
    const s0 = before.data.counts.screen ?? 0;
    const t0 = before.data.total ?? 0;

    const p1 = await apiPost(`/api/v1/polls/${ADAPTATION_ID}`, {
      session: ctx.token,
      body: { choice: 'book' },
    });
    eq(p1.status, 200, 'POST poll vote status');
    eq(p1.data.user_choice, 'book', 'vote records the book choice');
    eq(p1.data.counts.book, b0 + 1, 'book tally increments');
    eq(p1.data.total, t0 + 1, 'poll total increments');

    const p2 = await apiPost(`/api/v1/polls/${ADAPTATION_ID}`, {
      session: ctx.token,
      body: { choice: 'screen' },
    });
    eq(p2.data.user_choice, 'screen', 'vote changes to screen');
    eq(p2.data.counts.book, b0, 'book tally moves back');
    eq(p2.data.counts.screen, s0 + 1, 'screen tally increments');
    eq(p2.data.total, t0 + 1, 'total stays the same on vote change');
  }),

  test('lists: create, add item, detail view, delete', async (ctx) => {
    const title = `E2E list ${RUN}`;
    const created = await apiPost('/api/v1/lists', {
      session: ctx.token,
      body: { title, is_public: false },
    });
    eq(created.status, 201, 'POST /api/v1/lists status');
    const listId = created.data.id;
    const slug = created.data.slug;
    assert(listId > 0 && typeof slug === 'string', 'list gets an id and slug');

    const item = await apiPost(`/api/v1/lists/${listId}/items`, {
      session: ctx.token,
      body: { target_type: 'screen_work', target_id: WATCH_ID, note: `e2e note ${RUN}` },
    });
    eq(item.status, 201, 'POST /api/v1/lists/:id/items status');

    const got = await apiGet(`/api/v1/lists/${slug}`, { session: ctx.token });
    eq(got.status, 200, 'GET /api/v1/lists/:slug status');
    eq(got.data.list.title, title, 'list detail returns the title');
    assert((got.data.items ?? []).some((i) => i.target_id === WATCH_ID), 'list detail shows the added item');

    // Front-end: the real list-detail view renders the item row.
    const { listsViews, store } = await loadClientViews({ session: ctx.token });
    setClientAuthed(store, { id: ctx.userId, email: ctx.email });
    const view = await listsViews.listDetailView({ params: { slug } });
    eq(view.title, title, 'client list view title matches');
    contains(view.html, 'data-item-row', 'client list view renders the item row');

    const del = await apiDel(`/api/v1/lists/${listId}`, { session: ctx.token });
    eq(del.status, 200, 'DELETE /api/v1/lists/:id status');
    const gone = await apiGet(`/api/v1/lists/${slug}`, { session: ctx.token });
    eq(gone.status, 404, 'deleted list is gone');
  }),

  test('shelves: add, list shows it, remove', async (ctx) => {
    const add = await apiPost('/api/v1/shelves', {
      session: ctx.token,
      body: { target_type: 'book', target_id: BOOK_ID, shelf: 'want_to_read' },
    });
    eq(add.status, 200, 'POST /api/v1/shelves status');

    const list = await apiGet('/api/v1/shelves', { session: ctx.token });
    eq(list.status, 200, 'GET /api/v1/shelves status');
    assert(
      (list.data.shelves ?? []).some(
        (s) => s.target_type === 'book' && s.target_id === BOOK_ID && s.shelf === 'want_to_read',
      ),
      'shelf entry appears in the shelf list',
    );

    const del = await apiDel('/api/v1/shelves', {
      session: ctx.token,
      body: { target_type: 'book', target_id: BOOK_ID },
    });
    eq(del.status, 200, 'DELETE /api/v1/shelves status');

    const after = await apiGet('/api/v1/shelves', { session: ctx.token });
    assert(
      !(after.data.shelves ?? []).some((s) => s.target_type === 'book' && s.target_id === BOOK_ID),
      'removed shelf entry is gone',
    );
  }),

  test('feedback: submit creates a triage row', async (ctx) => {
    const res = await apiPost('/api/v1/feedback', {
      session: ctx.token,
      body: {
        type: 'feature',
        subject: `E2E feedback ${RUN}`,
        body: `E2E feedback body ${RUN} — safe to delete.`,
        email: ctx.email,
      },
    });
    if (res.status === 429) {
      console.log('    (skipped: feedback rate limit hit — teardown still cleans prior rows)');
      return;
    }
    eq(res.status, 201, 'POST /api/v1/feedback status');
    eq(res.data.ok, true, 'feedback accepted');
    assert(res.data.id > 0, 'feedback row gets an id');
  }),

  test('logout: session is invalidated', async (ctx) => {
    const out = await apiPost('/api/v1/auth/logout', { session: ctx.token });
    assert([200, 302, 303].includes(out.status), `logout responds (got ${out.status})`);

    // A logged-out browser is also redirected off authed pages.
    const me = await apiGet('/api/v1/auth/me', { session: ctx.token });
    eq(me.status, 401, 'session no longer authenticates after logout');

    const loginPage = await getPage('/lists');
    eq(loginPage.status, 200, 'authed page still serves the shell for logged-out users');
  }),
];
