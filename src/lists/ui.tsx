/** @jsxImportSource hono/jsx */
/**
 * src/lists/ui.tsx — server-rendered UI for shareable user lists (Track 5).
 *
 * Reuses the Layout, PosterArt, and theme classes from src/ui.tsx (imported,
 * not copied). Interactions are dependency-free vanilla JS, following the
 * vote/shelf inline-script pattern in src/ui.tsx.
 */
import type { Child } from 'hono/jsx';
import { Layout, PosterArt, type AuthUser } from '../ui';
import type { ListTargetType } from './db';

// ---------------------------------------------------------------------------
// List-scoped styles (appended to the theme; GLOBAL_CSS stays untouched)
// ---------------------------------------------------------------------------

const LIST_CSS = `
.list-card { display: flex; gap: 1.1rem; align-items: center; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.1rem 1.3rem; margin-bottom: .8rem; transition: border-color .2s; }
.list-card:hover { border-color: #3a4152; }
.list-card .grow { flex: 1; min-width: 0; }
.list-card h3 { margin: 0 0 .3rem; font-size: 1.12rem; line-height: 1.3; }
.list-card h3 a { color: var(--text); }
.list-card h3 a:hover { color: var(--gold-soft); text-decoration: none; }
.list-card .desc { color: var(--muted); font-size: .9rem; margin: .25rem 0 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.list-card .row-actions, .list-item .row-actions { display: flex; gap: .45rem; flex-wrap: wrap; align-items: center; flex: none; }
.list-item { display: flex; gap: 1rem; align-items: center; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: .85rem 1.1rem; margin-bottom: .7rem; }
.list-item .thumb { width: 56px; flex: none; }
.list-item .grow { flex: 1; min-width: 0; }
.list-item h3 { margin: 0 0 .2rem; font-size: 1.02rem; }
.list-item h3 a { color: var(--text); }
.list-item h3 a:hover { color: var(--gold-soft); text-decoration: none; }
.list-item .sub { color: var(--muted); font-size: .85rem; margin: 0; }
.list-item .note { color: #c9cdd6; font-size: .88rem; font-style: italic; margin: .35rem 0 0; border-left: 2px solid var(--gold); padding-left: .6rem; }
.list-item .pos { color: var(--faint); font-family: var(--serif); font-size: 1.25rem; font-weight: 700; width: 2rem; text-align: center; flex: none; }
.f-label { font-size: .85rem; font-weight: 600; color: var(--muted); display: grid; gap: .35rem; }
.f-input { font: inherit; padding: .65rem .9rem; border-radius: 10px; border: 1px solid var(--border); background: var(--bg-soft); color: var(--text); width: 100%; box-sizing: border-box; }
.f-input:focus { outline: none; border-color: var(--gold); }
textarea.f-input { min-height: 4.5rem; resize: vertical; }
.f-row { display: flex; gap: .6rem; flex-wrap: wrap; align-items: flex-end; }
.f-row .f-label { flex: 1 1 10rem; }
.check-row { display: flex; gap: .5rem; align-items: center; font-size: .9rem; color: var(--muted); }
.form-error { background: rgba(224,82,82,.12); border: 1px solid rgba(224,82,82,.5); color: #ff9d9d; border-radius: 10px; padding: .7rem 1rem; font-size: .88rem; display: none; }
.share-box { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; background: var(--bg-soft); border: 1px solid var(--border); border-radius: 10px; padding: .7rem 1rem; margin-top: 1.25rem; }
.share-box code { font-size: .85rem; color: var(--link); word-break: break-all; }
.add-to-list { display: flex; gap: .5rem; align-items: center; }
.add-to-list.done .btn { border-color: var(--green); color: var(--green); }
.add-to-list .msg { font-size: .82rem; color: var(--muted); }
`;

// ---------------------------------------------------------------------------
// Shared vanilla JS for the list pages
// ---------------------------------------------------------------------------

const LIST_SCRIPT = `
(function () {
  async function reqJson(path, opts) {
    var init = { headers: { 'Content-Type': 'application/json' } };
    if (opts) for (var k in opts) init[k] = opts[k];
    const res = await fetch(path, init);
    let data = {};
    try { data = await res.json(); } catch (e) {}
    return { ok: res.ok, status: res.status, data: data };
  }
  function showFormError(msg) {
    var el = document.querySelector('.form-error');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
    else alert(msg);
  }
  function authed(res) {
    if (res.status === 401 || res.status === 403) { window.location.href = '/auth/login'; return false; }
    return true;
  }

  // --- create list ---
  var createForm = document.getElementById('create-list-form');
  if (createForm) {
    createForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      var title = createForm.querySelector('[name="title"]').value.trim();
      var description = createForm.querySelector('[name="description"]').value.trim();
      var isPublic = createForm.querySelector('[name="is_public"]').checked;
      if (!title) { showFormError('Give your list a title.'); return; }
      var r = await reqJson('/api/lists', {
        method: 'POST',
        body: JSON.stringify({ title: title, description: description || null, is_public: isPublic }),
      });
      if (!r.ok) {
        if (r.status === 429) { showFormError('Slow down — 20 lists per hour.'); return; }
        if (!authed(r)) return;
        showFormError((r.data && r.data.error) || 'Could not create the list.');
        return;
      }
      window.location.href = '/lists/' + r.data.slug;
    });
  }

  // --- rename (edit) list ---
  document.querySelectorAll('[data-list-edit]').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var id = btn.getAttribute('data-list-edit');
      var title = prompt('List title:', btn.getAttribute('data-title') || '');
      if (title === null) return;
      title = title.trim();
      if (!title) { alert('Title cannot be empty.'); return; }
      var description = prompt('Description (optional):', btn.getAttribute('data-description') || '');
      if (description === null) return;
      var isPublic = confirm('Make this list public? (OK = public, Cancel = private)');
      var r = await reqJson('/api/lists/' + id, {
        method: 'PUT',
        body: JSON.stringify({ title: title, description: description.trim() || null, is_public: isPublic }),
      });
      if (!r.ok) { if (!authed(r)) return; alert((r.data && r.data.error) || 'Could not update the list.'); return; }
      window.location.reload();
    });
  });

  // --- delete list ---
  document.querySelectorAll('[data-list-delete]').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var id = btn.getAttribute('data-list-delete');
      var title = btn.getAttribute('data-title') || 'this list';
      if (!confirm('Delete "' + title + '" and all its items? This cannot be undone.')) return;
      var r = await reqJson('/api/lists/' + id, { method: 'DELETE' });
      if (!r.ok) { if (!authed(r)) return; alert((r.data && r.data.error) || 'Could not delete the list.'); return; }
      var row = btn.closest('[data-list-row]');
      if (row) row.remove(); else window.location.href = '/lists';
    });
  });

  // --- toggle public/private (detail page) ---
  var visBtn = document.querySelector('[data-list-visibility]');
  if (visBtn) {
    visBtn.addEventListener('click', async function () {
      var id = visBtn.getAttribute('data-list-id');
      var makePublic = visBtn.getAttribute('data-list-visibility') === 'private';
      var r = await reqJson('/api/lists/' + id, {
        method: 'PUT',
        body: JSON.stringify({ is_public: makePublic }),
      });
      if (!r.ok) { if (!authed(r)) return; alert((r.data && r.data.error) || 'Could not update visibility.'); return; }
      window.location.reload();
    });
  }

  // --- add item (detail page owner form) ---
  var addForm = document.getElementById('add-item-form');
  if (addForm) {
    addForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      var listId = addForm.getAttribute('data-list-id');
      var targetType = addForm.querySelector('[name="target_type"]').value;
      var targetId = Number(addForm.querySelector('[name="target_id"]').value);
      var note = addForm.querySelector('[name="note"]').value.trim();
      if (!targetId || targetId < 1) { alert('Enter a valid ID.'); return; }
      var r = await reqJson('/api/lists/' + listId + '/items', {
        method: 'POST',
        body: JSON.stringify({ target_type: targetType, target_id: targetId, note: note || null }),
      });
      if (!r.ok) {
        if (!authed(r)) return;
        alert((r.data && r.data.error) || 'Could not add the item.');
        return;
      }
      window.location.reload();
    });
  }

  // --- remove item ---
  document.querySelectorAll('[data-item-delete]').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var listId = btn.getAttribute('data-list-id');
      var itemId = btn.getAttribute('data-item-delete');
      if (!confirm('Remove this item from the list?')) return;
      var r = await reqJson('/api/lists/' + listId + '/items/' + itemId, { method: 'DELETE' });
      if (!r.ok) { if (!authed(r)) return; alert((r.data && r.data.error) || 'Could not remove the item.'); return; }
      var row = btn.closest('[data-item-row]');
      if (row) row.remove(); else window.location.reload();
    });
  });

  // --- reorder items (up/down arrows) ---
  function currentOrder() {
    return Array.prototype.map.call(
      document.querySelectorAll('[data-item-row]'),
      function (row) { return Number(row.getAttribute('data-item-row')); }
    );
  }
  document.querySelectorAll('[data-item-move]').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var listId = btn.getAttribute('data-list-id');
      var dir = Number(btn.getAttribute('data-item-move')); // -1 or 1
      var order = currentOrder();
      var itemId = Number(btn.closest('[data-item-row]').getAttribute('data-item-row'));
      var i = order.indexOf(itemId);
      var j = i + dir;
      if (i < 0 || j < 0 || j >= order.length) return;
      var tmp = order[i]; order[i] = order[j]; order[j] = tmp;
      var r = await reqJson('/api/lists/' + listId + '/items', {
        method: 'PUT',
        body: JSON.stringify({ order: order }),
      });
      if (!r.ok) { if (!authed(r)) return; alert((r.data && r.data.error) || 'Could not reorder.'); return; }
      window.location.reload();
    });
  });

  // --- copy share link ---
  var copyBtn = document.querySelector('[data-copy-link]');
  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      var url = copyBtn.getAttribute('data-copy-link');
      function done() { copyBtn.textContent = 'Copied ✓'; setTimeout(function () { copyBtn.textContent = 'Copy link'; }, 2000); }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done, done);
      } else {
        var ta = document.createElement('textarea');
        ta.value = url; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta); done();
      }
    });
  }
})();
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserListView {
  id: number;
  title: string;
  description: string | null;
  isPublic: boolean;
  slug: string;
  itemCount: number;
  createdAt: string | null;
}

export interface ListItemViewProps {
  id: number;
  targetType: ListTargetType;
  targetId: number;
  note: string | null;
  title: string;
  subtitle: string;
  imageUrl: string | null;
  href: string;
}

// ---------------------------------------------------------------------------
// ListsPage — "My lists"
// ---------------------------------------------------------------------------

export function ListsPage({
  lists,
  user,
}: {
  lists: UserListView[];
  user: { email: string; isAdmin?: boolean };
}) {
  return (
    <Layout title="My lists" user={user} canonicalPath="/lists">
      <style>{LIST_CSS}</style>
      <p class="kicker">Your collection</p>
      <h1 class="display-title">My Lists</h1>
      <p class="lede">
        Curate books and movies into shareable lists — reading queues, ranked
        favorites, watch-party lineups. Public lists get a shareable link.
      </p>

      <section class="panel" style="margin-bottom:2.5rem">
        <h2>Create a new list</h2>
        <form id="create-list-form" style="display:grid;gap:.9rem">
          <label class="f-label">
            Title
            <input class="f-input" type="text" name="title" maxlength={120} placeholder="e.g. Cozy fantasy adaptations" required />
          </label>
          <label class="f-label">
            Description <span class="meta" style="font-weight:400">(optional)</span>
            <textarea class="f-input" name="description" maxlength={2000} placeholder="What's this list about?" />
          </label>
          <label class="check-row">
            <input type="checkbox" name="is_public" checked /> Public — anyone with the link can view it
          </label>
          <div class="form-error" role="alert"></div>
          <div>
            <button class="btn btn-primary" type="submit">Create list</button>
          </div>
        </form>
      </section>

      <h2 class="section-title">
        Your lists <span class="count">{lists.length}</span>
      </h2>
      {lists.length === 0 ? (
        <p class="empty">No lists yet — create your first one above.</p>
      ) : (
        <div>
          {lists.map((l) => (
            <div class="list-card" data-list-row key={l.id}>
              <div class="grow">
                <h3>
                  <a href={`/lists/${l.slug}`}>{l.title}</a>
                </h3>
                {l.description && <p class="desc">{l.description}</p>}
                <p class="meta">
                  {l.itemCount} {l.itemCount === 1 ? 'item' : 'items'}
                  {' · '}
                  {l.isPublic ? '🌐 Public' : '🔒 Private'}
                  {l.createdAt && <> {' · '} created {l.createdAt.slice(0, 10)}</>}
                </p>
              </div>
              <div class="row-actions">
                <button
                  class="btn btn-sm"
                  type="button"
                  data-list-edit={String(l.id)}
                  data-title={l.title}
                  data-description={l.description ?? ''}
                >
                  Edit
                </button>
                <button
                  class="btn btn-sm"
                  type="button"
                  data-list-delete={String(l.id)}
                  data-title={l.title}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <script dangerouslySetInnerHTML={{ __html: LIST_SCRIPT }} />
    </Layout>
  );
}

// ---------------------------------------------------------------------------
// ListDetailPage — public list view (+ owner controls)
// ---------------------------------------------------------------------------

export function ListDetailPage({
  list,
  items,
  isOwner,
  user,
  origin,
  canonicalPath,
  ogDescription,
  ogImage,
}: {
  list: { id: number; title: string; description: string | null; isPublic: boolean; slug: string; createdAt: string | null };
  items: ListItemViewProps[];
  isOwner: boolean;
  user: AuthUser;
  origin?: string;
  canonicalPath?: string;
  ogDescription?: string;
  ogImage?: string;
}) {
  return (
    <Layout
      title={list.title}
      user={user}
      origin={origin}
      canonicalPath={canonicalPath}
      description={ogDescription}
      image={ogImage}
    >
      <style>{LIST_CSS}</style>
      <a class="back-link" href={isOwner ? '/lists' : '/'}>← {isOwner ? 'My lists' : 'Browse'}</a>
      <p class="kicker">{list.isPublic ? 'Public list' : 'Private list'}</p>
      <h1 class="display-title">{list.title}</h1>
      {list.description ? (
        <p class="lede">{list.description}</p>
      ) : (
        <p class="lede meta">No description yet.</p>
      )}
      <p class="meta">
        {items.length} {items.length === 1 ? 'title' : 'titles'}
        {list.createdAt && <> {' · '} created {list.createdAt.slice(0, 10)}</>}
      </p>

      {list.isPublic && origin && (
        <div class="share-box">
          <span class="meta">Share this list:</span>
          <code>{origin}/lists/{list.slug}</code>
          <button class="btn btn-sm" type="button" data-copy-link={`${origin}/lists/${list.slug}`}>
            Copy link
          </button>
        </div>
      )}
      {!list.isPublic && isOwner && (
        <p class="meta" style="margin-top:1rem">
          🔒 Only you can see this list. Make it public below to share it.
        </p>
      )}

      {isOwner && (
        <>
          <div class="actions" style="margin-top:1.5rem">
            <button
              class="btn btn-sm"
              type="button"
              data-list-edit={String(list.id)}
              data-title={list.title}
              data-description={list.description ?? ''}
            >
              Edit title &amp; description
            </button>
            <button
              class="btn btn-sm"
              type="button"
              data-list-visibility={list.isPublic ? 'public' : 'private'}
              data-list-id={String(list.id)}
            >
              {list.isPublic ? 'Make private' : 'Make public'}
            </button>
            <button
              class="btn btn-sm"
              type="button"
              data-list-delete={String(list.id)}
              data-title={list.title}
            >
              Delete list
            </button>
          </div>

          <section class="panel" style="margin-top:1.5rem">
            <h2>Add an item</h2>
            <form id="add-item-form" data-list-id={String(list.id)}>
              <div class="f-row">
                <label class="f-label" style="flex:0 1 11rem">
                  Kind
                  <select class="f-input" name="target_type">
                    <option value="book">Book</option>
                    <option value="screen_work">Movie / series</option>
                  </select>
                </label>
                <label class="f-label" style="flex:0 1 9rem">
                  ID
                  <input class="f-input" type="number" name="target_id" min={1} placeholder="e.g. 42" />
                </label>
                <label class="f-label" style="flex:2 1 14rem">
                  Note <span class="meta" style="font-weight:400">(optional)</span>
                  <input class="f-input" type="text" name="note" maxlength={500} placeholder="Why it's on the list…" />
                </label>
                <button class="btn btn-primary" type="submit">Add</button>
              </div>
              <p class="meta" style="margin:.6rem 0 0">
                Tip: add books and movies straight from their pages with the “Add to list” control.
              </p>
            </form>
          </section>
        </>
      )}

      <h2 class="section-title">
        The list <span class="count">{items.length}</span>
      </h2>
      {items.length === 0 ? (
        <p class="empty">
          {isOwner
            ? 'Nothing here yet — add your first item above.'
            : 'This list is empty.'}
        </p>
      ) : (
        <ol style="list-style:none;margin:0;padding:0">
          {items.map((item, i) => (
            <li class="list-item" data-item-row={String(item.id)} key={item.id}>
              <span class="pos" aria-hidden="true">{i + 1}</span>
              <div class="thumb">
                <PosterArt src={item.imageUrl} title={item.title} subtitle={item.subtitle} />
              </div>
              <div class="grow">
                <h3>
                  <a href={item.href}>{item.title}</a>
                </h3>
                <p class="sub">{item.subtitle}</p>
                {item.note && <p class="note">{item.note}</p>}
              </div>
              {isOwner && (
                <div class="row-actions">
                  <button
                    class="btn btn-sm"
                    type="button"
                    title="Move up"
                    aria-label={`Move ${item.title} up`}
                    data-item-move="-1"
                    data-list-id={String(list.id)}
                  >
                    ↑
                  </button>
                  <button
                    class="btn btn-sm"
                    type="button"
                    title="Move down"
                    aria-label={`Move ${item.title} down`}
                    data-item-move="1"
                    data-list-id={String(list.id)}
                  >
                    ↓
                  </button>
                  <button
                    class="btn btn-sm"
                    type="button"
                    data-item-delete={String(item.id)}
                    data-list-id={String(list.id)}
                  >
                    Remove
                  </button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      <script dangerouslySetInnerHTML={{ __html: LIST_SCRIPT }} />
    </Layout>
  );
}

// ---------------------------------------------------------------------------
// AddToListControl — compact "add this to one of my lists" picker
// ---------------------------------------------------------------------------

/**
 * Renders on book pages and screen-work pages. Logged-out users get nothing
 * (the control is hidden entirely); signed-in users pick one of their lists
 * and add the current title with one click.
 */
const ADD_TO_LIST_SCRIPT = `
(function () {
  async function reqJson(path, opts) {
    var init = { headers: { 'Content-Type': 'application/json' } };
    if (opts) for (var k in opts) init[k] = opts[k];
    const res = await fetch(path, init);
    let data = {};
    try { data = await res.json(); } catch (e) {}
    return { ok: res.ok, status: res.status, data: data };
  }
  document.querySelectorAll('[data-add-to-list]').forEach(function (box) {
    var sel = box.querySelector('select');
    var btn = box.querySelector('button');
    var msg = box.querySelector('.msg');
    function say(t) { if (msg) msg.textContent = t; }
    btn.addEventListener('click', async function () {
      var listId = sel.value;
      if (!listId) { say('Pick a list first.'); return; }
      btn.disabled = true;
      var r = await reqJson('/api/lists/' + listId + '/items', {
        method: 'POST',
        body: JSON.stringify({
          target_type: box.getAttribute('data-target-type'),
          target_id: Number(box.getAttribute('data-target-id')),
        }),
      });
      btn.disabled = false;
      if (r.ok) {
        box.classList.add('done');
        say('Added ✓');
        return;
      }
      if (r.status === 409) { say('Already on that list.'); return; }
      if (r.status === 401 || r.status === 403) { window.location.href = '/auth/login'; return; }
      say((r.data && r.data.error) || 'Could not add.');
    });
  });
})();
`;

export function AddToListControl({
  targetType,
  targetId,
  userLists,
  signedIn,
}: {
  targetType: ListTargetType;
  targetId: number;
  userLists: { id: number; title: string }[];
  signedIn: boolean;
}) {
  // Logged-out users never see the control.
  if (!signedIn) return <></>;
  if (userLists.length === 0) {
    return (
      <span class="add-to-list">
        <a class="btn btn-sm" href="/lists">Create a list to save this</a>
      </span>
    );
  }
  return (
    <span class="add-to-list" data-add-to-list data-target-type={targetType} data-target-id={String(targetId)}>
      <select class="shelf-select" aria-label="Add to a list" title="Add to one of your lists">
        <option value="">＋ List…</option>
        {userLists.map((l) => (
          <option value={String(l.id)} key={l.id}>{l.title}</option>
        ))}
      </select>
      <button class="btn btn-sm" type="button">Add</button>
      <span class="msg" role="status"></span>
      <script dangerouslySetInnerHTML={{ __html: ADD_TO_LIST_SCRIPT }} />
    </span>
  );
}
