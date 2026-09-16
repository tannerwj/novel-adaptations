// public/js/views/lists.js — My lists, public list detail, Shelves.

import { esc, posterArt } from '../utils.js';
import { api, errMsg } from '../api.js';
import { navigate, renderNotFound, rerender } from '../router.js';
import { pagination, wirePagination } from '../components.js';

// ---------------------------------------------------------------------------
// /lists — My lists (auth)
// ---------------------------------------------------------------------------

function listCardHtml(l) {
  return (
    `<div class="list-card" data-list-row>` +
      `<div class="grow">` +
        `<h3><a href="/lists/${esc(l.slug)}">${esc(l.title)}</a></h3>` +
        (l.description ? `<p class="desc">${esc(l.description)}</p>` : '') +
        `<p class="meta">${l.item_count} ${l.item_count === 1 ? 'item' : 'items'} · ${l.is_public ? '🌐 Public' : '🔒 Private'}` +
        (l.created_at ? ` · created ${esc(l.created_at.slice(0, 10))}` : '') + `</p>` +
      `</div>` +
      `<div class="row-actions">` +
        `<button class="btn btn-sm" type="button" data-list-edit="${l.id}" data-title="${esc(l.title)}" data-description="${esc(l.description ?? '')}" data-is-public="${l.is_public ? '1' : '0'}">Edit</button>` +
        `<button class="btn btn-sm" type="button" data-list-delete="${l.id}" data-title="${esc(l.title)}">Delete</button>` +
      `</div>` +
    `</div>`
  );
}

export async function myListsView() {
  const renderPage = async (page = 1) => {
    const r = await api(`/api/v1/lists?page=${page}&per_page=50`);
    if (!r.ok) throw new Error(errMsg(r));
    const { data, page: pg, per_page, total } = r.data;
    return {
      title: 'My lists',
      html:
        `<p class="kicker">Your collection</p>` +
        `<h1 class="display-title">My Lists</h1>` +
        `<p class="lede">Curate books and movies into shareable lists — reading queues, ranked favorites, watch-party lineups. Public lists get a shareable link.</p>` +
        `<section class="panel" style="margin-bottom:2.5rem">` +
          `<h2>Create a new list</h2>` +
          `<form data-create-list style="display:grid;gap:.9rem">` +
            `<label class="f-label">Title` +
              `<input class="f-input" type="text" name="title" maxlength="120" placeholder="e.g. Cozy fantasy adaptations" required></label>` +
            `<label class="f-label">Description <span class="meta" style="font-weight:400">(optional)</span>` +
              `<textarea class="f-input" name="description" maxlength="2000" placeholder="What's this list about?"></textarea></label>` +
            `<label class="check-row"><input type="checkbox" name="is_public" checked> Public — anyone with the link can view it</label>` +
            `<div class="form-error" role="alert"></div>` +
            `<div><button class="btn btn-primary" type="submit">Create list</button></div>` +
          `</form>` +
        `</section>` +
        `<h2 class="section-title">Your lists <span class="count">${total}</span></h2>` +
        (data.length === 0
          ? `<p class="empty">No lists yet — create your first one above.</p>`
          : `<div data-lists>${data.map(listCardHtml).join('')}</div>`) +
        pagination(pg, per_page, total),
      after(root) {
        const form = root.querySelector('[data-create-list]');
        const errEl = form.querySelector('.form-error');
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          errEl.classList.remove('visible');
          const fd = new FormData(form);
          const title = String(fd.get('title') || '').trim();
          if (!title) { errEl.textContent = 'Give your list a title.'; errEl.classList.add('visible'); return; }
          const r2 = await api('/api/v1/lists', {
            method: 'POST',
            body: {
              title,
              description: String(fd.get('description') || '').trim() || null,
              is_public: fd.get('is_public') === 'on',
            },
          });
          if (!r2.ok) {
            errEl.textContent = r2.code === 'rate_limited' ? 'Slow down — 20 lists per hour.' : errMsg(r2);
            errEl.classList.add('visible');
            return;
          }
          navigate('/lists/' + r2.data.slug);
        });
        wireListRowActions(root);
        wirePagination(root, (p) => refresh(p));
      },
    };
  };
  const out = await renderPage(1);
  const refresh = async (page) => {
    const next = await renderPage(page);
    document.title = `${next.title} — Novel Adaptations`;
    document.getElementById('app').innerHTML = next.html;
    next.after(document.getElementById('app'));
  };
  return out;
}

/** Edit / delete buttons on list cards (shared by /lists and /lists/:slug). */
export function wireListRowActions(root) {
  root.querySelectorAll('[data-list-edit]').forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', async () => {
      const id = btn.dataset.listEdit;
      const title = prompt('List title:', btn.dataset.title || '');
      if (title === null) return;
      if (!title.trim()) { alert('Title cannot be empty.'); return; }
      const description = prompt('Description (optional):', btn.dataset.description || '');
      if (description === null) return;
      const isPublic = confirm('Make this list public? (OK = public, Cancel = private)');
      const r = await api(`/api/v1/lists/${id}`, {
        method: 'PUT',
        body: { title: title.trim(), description: description.trim() || null, is_public: isPublic },
      });
      if (!r.ok) { alert(errMsg(r)); return; }
      // Refresh the current route in place.
      rerender();
    });
  });
  root.querySelectorAll('[data-list-delete]').forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', async () => {
      const id = btn.dataset.listDelete;
      if (!confirm(`Delete "${btn.dataset.title || 'this list'}" and all its items? This cannot be undone.`)) return;
      const r = await api(`/api/v1/lists/${id}`, { method: 'DELETE' });
      if (!r.ok) { alert(errMsg(r)); return; }
      const row = btn.closest('[data-list-row]');
      if (row) row.remove();
      else navigate('/lists');
    });
  });
}

// ---------------------------------------------------------------------------
// /lists/:slug — public list detail (+ owner controls)
// ---------------------------------------------------------------------------

export async function listDetailView({ params }) {
  const slug = params.slug;
  const r = await api(`/api/v1/lists/${encodeURIComponent(slug)}`, { loginRedirect: false });
  if (!r.ok) {
    if (r.status === 404) { renderNotFound(); return { title: 'Not found', html: '' }; }
    throw new Error(errMsg(r));
  }
  const { list, items, is_owner } = r.data;
  const origin = window.location.origin;

  return {
    title: list.title,
    html:
      `<a class="back-link" href="${is_owner ? '/lists' : '/'}">← ${is_owner ? 'My lists' : 'Browse'}</a>` +
      `<p class="kicker">${list.is_public ? 'Public list' : 'Private list'}</p>` +
      `<h1 class="display-title">${esc(list.title)}</h1>` +
      (list.description ? `<p class="lede">${esc(list.description)}</p>` : `<p class="lede meta">No description yet.</p>`) +
      `<p class="meta">${items.length} ${items.length === 1 ? 'title' : 'titles'}` +
      (list.created_at ? ` · created ${esc(list.created_at.slice(0, 10))}` : '') + `</p>` +
      (list.is_public
        ? `<div class="share-box"><span class="meta">Share this list:</span>` +
          `<code>${esc(origin)}/lists/${esc(list.slug)}</code>` +
          `<button class="btn btn-sm" type="button" data-copy-link="${esc(origin)}/lists/${esc(list.slug)}">Copy link</button></div>`
        : (is_owner ? `<p class="meta" style="margin-top:1rem">🔒 Only you can see this list. Make it public below to share it.</p>` : '')) +
      (is_owner
        ? `<div class="actions" style="margin-top:1.5rem">` +
            `<button class="btn btn-sm" type="button" data-list-edit="${list.id}" data-title="${esc(list.title)}" data-description="${esc(list.description ?? '')}" data-is-public="${list.is_public ? '1' : '0'}">Edit title &amp; description</button>` +
            `<button class="btn btn-sm" type="button" data-list-visibility data-list-id="${list.id}" data-make-public="${list.is_public ? '0' : '1'}">${list.is_public ? 'Make private' : 'Make public'}</button>` +
            `<button class="btn btn-sm" type="button" data-list-delete="${list.id}" data-title="${esc(list.title)}">Delete list</button>` +
          `</div>` +
          `<section class="panel" style="margin-top:1.5rem"><h2>Add an item</h2>` +
            `<form data-add-item data-list-id="${list.id}">` +
              `<div class="f-row">` +
                `<label class="f-label" style="flex:0 1 11rem">Kind` +
                  `<select class="f-input" name="target_type"><option value="book">Book</option><option value="screen_work">Movie / series</option></select></label>` +
                `<label class="f-label" style="flex:0 1 9rem">ID` +
                  `<input class="f-input" type="number" name="target_id" min="1" placeholder="e.g. 42"></label>` +
                `<label class="f-label" style="flex:2 1 14rem">Note <span class="meta" style="font-weight:400">(optional)</span>` +
                  `<input class="f-input" type="text" name="note" maxlength="500" placeholder="Why it's on the list…"></label>` +
                `<button class="btn btn-primary" type="submit">Add</button>` +
              `</div>` +
              `<p class="meta" style="margin:.6rem 0 0">Tip: add books and movies straight from their pages with the “Add to list” control.</p>` +
            `</form>` +
          `</section>`
        : '') +
      `<h2 class="section-title">The list <span class="count">${items.length}</span></h2>` +
      (items.length === 0
        ? `<p class="empty">${is_owner ? 'Nothing here yet — add your first item above.' : 'This list is empty.'}</p>`
        : `<ol style="list-style:none;margin:0;padding:0" data-item-list>` +
          items.map((item, i) =>
            `<li class="list-item" data-item-row="${item.id}">` +
              `<span class="pos" aria-hidden="true">${i + 1}</span>` +
              `<div class="thumb">${posterArt(item.image_url, item.title, item.subtitle)}</div>` +
              `<div class="grow">` +
                `<h3><a href="${esc(item.href)}">${esc(item.title)}</a></h3>` +
                `<p class="sub">${esc(item.subtitle)}</p>` +
                (item.note ? `<p class="note">${esc(item.note)}</p>` : '') +
              `</div>` +
              (is_owner
                ? `<div class="row-actions">` +
                    `<button class="btn btn-sm btn-ghost" type="button" title="Move up" aria-label="Move ${esc(item.title)} up" data-item-move="-1" data-list-id="${list.id}">↑</button>` +
                    `<button class="btn btn-sm btn-ghost" type="button" title="Move down" aria-label="Move ${esc(item.title)} down" data-item-move="1" data-list-id="${list.id}">↓</button>` +
                    `<button class="btn btn-sm btn-ghost" type="button" data-item-delete="${item.id}" data-list-id="${list.id}">Remove</button>` +
                  `</div>`
                : '') +
            `</li>`
          ).join('') +
          `</ol>`),
    after(root) {
      wireListRowActions(root);

      const visBtn = root.querySelector('[data-list-visibility]');
      if (visBtn) {
        visBtn.addEventListener('click', async () => {
          const r2 = await api(`/api/v1/lists/${visBtn.dataset.listId}`, {
            method: 'PUT',
            body: { is_public: visBtn.dataset.makePublic === '1' },
          });
          if (!r2.ok) { alert(errMsg(r2)); return; }
          rerender();
        });
      }

      const addForm = root.querySelector('[data-add-item]');
      if (addForm) {
        addForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(addForm);
          const targetId = Number(fd.get('target_id'));
          if (!targetId || targetId < 1) { alert('Enter a valid ID.'); return; }
          const r2 = await api(`/api/v1/lists/${addForm.dataset.listId}/items`, {
            method: 'POST',
            body: {
              target_type: String(fd.get('target_type')),
              target_id: targetId,
              note: String(fd.get('note') || '').trim() || null,
            },
          });
          if (!r2.ok) { alert(errMsg(r2)); return; }
          rerender();
        });
      }

      root.querySelectorAll('[data-item-delete]').forEach((btn) => {
        if (btn.dataset.wired) return;
        btn.dataset.wired = '1';
        btn.addEventListener('click', async () => {
          if (!confirm('Remove this item from the list?')) return;
          const r2 = await api(`/api/v1/lists/${btn.dataset.listId}/items/${btn.dataset.itemDelete}`, { method: 'DELETE' });
          if (!r2.ok) { alert(errMsg(r2)); return; }
          const row = btn.closest('[data-item-row]');
          if (row) row.remove();
        });
      });

      const currentOrder = () =>
        [...root.querySelectorAll('[data-item-row]')].map((row) => Number(row.dataset.itemRow));
      root.querySelectorAll('[data-item-move]').forEach((btn) => {
        if (btn.dataset.wired) return;
        btn.dataset.wired = '1';
        btn.addEventListener('click', async () => {
          const order = currentOrder();
          const row = btn.closest('[data-item-row]');
          const itemId = Number(row.dataset.itemRow);
          const i = order.indexOf(itemId);
          const j = i + Number(btn.dataset.itemMove);
          if (i < 0 || j < 0 || j >= order.length) return;
          [order[i], order[j]] = [order[j], order[i]];
          const r2 = await api(`/api/v1/lists/${btn.dataset.listId}/items`, {
            method: 'PUT',
            body: { order },
          });
          if (!r2.ok) { alert(errMsg(r2)); return; }
          // Swap the DOM rows in place (no reload).
          const rows = [...root.querySelectorAll('[data-item-row]')];
          const a = rows[i], b = rows[j];
          const parent = a.parentNode;
          const aNext = a.nextSibling === b ? a : a.nextSibling;
          parent.insertBefore(b, a);
          parent.insertBefore(a, b.nextSibling === a ? aNext : b.nextSibling);
          // Renumber the position badges.
          [...parent.querySelectorAll('[data-item-row] .pos')].forEach((pos, idx) => { pos.textContent = idx + 1; });
        });
      });

      const copyBtn = root.querySelector('[data-copy-link]');
      if (copyBtn) {
        copyBtn.addEventListener('click', () => {
          const done = () => {
            copyBtn.textContent = 'Copied ✓';
            setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 2000);
          };
          const url = copyBtn.dataset.copyLink;
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, done);
          else {
            const ta = document.createElement('textarea');
            ta.value = url;
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch { /* noop */ }
            document.body.removeChild(ta);
            done();
          }
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// /shelves — Shelves (auth)
// ---------------------------------------------------------------------------

const SHELF_ORDER = ['want_to_read', 'read', 'want_to_watch', 'watched'];
const SHELF_SECTION_TITLES = {
  want_to_read: 'Reading',
  read: 'Read',
  want_to_watch: 'Watchlist',
  watched: 'Watched',
};

function shelfLabelOf(s) {
  return SHELF_SECTION_TITLES[s] ?? s.replace(/_/g, ' ');
}

export async function shelvesView() {
  const r = await api('/api/v1/shelves');
  if (!r.ok) throw new Error(errMsg(r));
  const shelves = r.data.shelves;
  const grouped = new Map();
  for (const s of shelves) {
    const arr = grouped.get(s.shelf) || [];
    arr.push(s);
    grouped.set(s.shelf, arr);
  }
  const ordered = [
    ...SHELF_ORDER.filter((s) => grouped.has(s)),
    ...[...grouped.keys()].filter((k) => !SHELF_ORDER.includes(k)),
  ];
  return {
    title: 'My shelves',
    html:
      `<p class="kicker">Your collection</p>` +
      `<h1 class="display-title">Shelves</h1>` +
      `<p class="lede">Everything you've shelved — reading, read, watchlist, and watched.</p>` +
      (shelves.length === 0
        ? `<p class="empty">Your shelves are empty. Browse <a href="/">adaptations</a> and shelve something.</p>`
        : ordered.map((shelf) =>
            `<section class="shelf-group">` +
              `<h2>${esc(shelfLabelOf(shelf))} <span class="count">(${(grouped.get(shelf) || []).length})</span></h2>` +
              `<ul class="shelf-list">` +
              (grouped.get(shelf) || []).map((s) =>
                `<li>` +
                  `<span><a href="${s.target_type === 'book' ? `/books/${s.target_id}` : `/adaptations/${s.target_id}`}">${esc(s.title)}</a></span>` +
                  `<span class="shelf-kind kind-pill">${s.target_type === 'book' ? '📚 Book' : '🎬 Adaptation'}</span>` +
                `</li>`
              ).join('') +
              `</ul>` +
            `</section>`
          ).join('')),
  };
}
