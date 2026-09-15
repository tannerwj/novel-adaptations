// src/votes/client.ts — vanilla-JS <script> body for vote/shelf buttons.
// Track C embeds it in MostWantedPage (and detail pages) via
// <script dangerouslySetInnerHTML={{ __html: VOTE_SCRIPT }} />.
//
// Button contract (all interaction is data-attribute driven, no framework):
//   Vote:   <button data-vote-book="123" data-voted="0|1">
//             <span data-vote-label>…</span>
//           </button>
//   Shelf:  <button data-shelf-action="set|remove"
//                   data-target-type="book|adaptation"
//                   data-target-id="123"
//                   data-shelf="want_to_read|read|want_to_watch|watched">…</button>
//
// Vote responses update the button in place; 401s bounce to /auth/login.

export const VOTE_SCRIPT = `
(function () {
  'use strict';

  async function api(path, method, body) {
    var res;
    try {
      res = await fetch(path, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
      });
    } catch (e) {
      alert('Network error — please try again.');
      return null;
    }
    if (res.status === 401) {
      window.location.href = '/auth/login';
      return null;
    }
    if (res.status === 429) {
      alert('Vote limit reached — 20 votes per day. Come back tomorrow!');
      return null;
    }
    var data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      alert(data.error || ('Request failed (' + res.status + ')'));
      return null;
    }
    return data;
  }

  function refreshVoteUI(btn, voted, votes) {
    btn.setAttribute('data-voted', voted ? '1' : '0');
    var label = btn.querySelector('[data-vote-label]');
    if (label) {
      label.textContent = (voted ? '★ Voted (' : '☆ Vote (') + votes + ')';
    }
    var row = btn.closest('[data-vote-row]');
    var count = row ? row.querySelector('[data-vote-count]') : null;
    if (count) count.textContent = String(votes);
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!(t instanceof HTMLElement)) return;

    var voteBtn = t.closest('[data-vote-book]');
    if (voteBtn instanceof HTMLElement) {
      var bookId = voteBtn.getAttribute('data-vote-book');
      if (!bookId) return;
      var voted = voteBtn.getAttribute('data-voted') === '1';
      var promise = voted
        ? api('/api/votes/' + encodeURIComponent(bookId), 'DELETE')
        : api('/api/votes', 'POST', { bookId: Number(bookId) });
      promise.then(function (data) {
        if (data) refreshVoteUI(voteBtn, data.voted, data.votes);
      });
      return;
    }

    var shelfBtn = t.closest('[data-shelf-action]');
    if (shelfBtn instanceof HTMLElement) {
      var action = shelfBtn.getAttribute('data-shelf-action');
      var targetType = shelfBtn.getAttribute('data-target-type');
      var targetId = Number(shelfBtn.getAttribute('data-target-id'));
      var shelf = shelfBtn.getAttribute('data-shelf') || '';
      if (!targetType || !targetId) return;
      var p = action === 'remove'
        ? api('/api/shelves', 'DELETE', { targetType: targetType, targetId: targetId })
        : api('/api/shelves', 'POST', { targetType: targetType, targetId: targetId, shelf: shelf });
      p.then(function (data) {
        if (!data || !data.ok) return;
        var row = shelfBtn.closest('[data-shelf-row]');
        var note = row ? row.querySelector('[data-shelf-state]') : null;
        if (note) {
          note.textContent = action === 'remove'
            ? 'Removed from shelves.'
            : 'Saved to ' + shelf.replace(/_/g, ' ') + '.';
        }
      });
    }
  });
})();
`;
