// src/lists/db.ts — Track 5 data access: shareable user lists, list items,
// and list-creation rate limiting. (src/db.ts is owned by others.)

import { getBook, getScreenWork } from '../db';

export type ListTargetType = 'book' | 'screen_work';

export const LIST_TARGET_TYPES: ListTargetType[] = ['book', 'screen_work'];

export interface ListRow {
  id: number;
  user_id: number;
  title: string;
  description: string | null;
  is_public: number;
  slug: string;
  created_at: string | null;
  updated_at: string | null;
}

/** A list row plus the owner's item count (used by the /lists page). */
export interface UserListSummary extends ListRow {
  itemCount: number;
}

/** A list item with its target resolved for display. */
export interface ListItemView {
  id: number;
  listId: number;
  targetType: ListTargetType;
  targetId: number;
  position: number;
  note: string | null;
  title: string;
  subtitle: string;
  imageUrl: string | null;
  /** Detail-page path for the target (/books/:id or /watch/:id). */
  href: string;
}

export type NotFoundOrForbidden = 'not_found' | 'forbidden';

// --- slugs ------------------------------------------------------------------
// Format: lowercase, non-alphanumerics → hyphens, trimmed, max 60 chars,
// plus '-' + 6-char base36 suffix. Retried until unique.

function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

function randomBase36(length: number): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % 36]!).join('');
}

function buildSlug(title: string): string {
  const base = slugifyTitle(title) || 'list';
  return `${base}-${randomBase36(6)}`;
}

async function slugExists(db: D1Database, slug: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS one FROM lists WHERE slug = ?1')
    .bind(slug)
    .first<{ one: number }>();
  return row !== null;
}

// --- reads ------------------------------------------------------------------

export async function getListById(db: D1Database, id: number): Promise<ListRow | null> {
  const row = await db
    .prepare('SELECT * FROM lists WHERE id = ?1')
    .bind(id)
    .first<ListRow>();
  return row ?? null;
}

export async function getListBySlug(db: D1Database, slug: string): Promise<ListRow | null> {
  const row = await db
    .prepare('SELECT * FROM lists WHERE slug = ?1')
    .bind(slug)
    .first<ListRow>();
  return row ?? null;
}

/** All of a user's lists, newest first, each with its item count. */
export async function listUserLists(db: D1Database, userId: number): Promise<UserListSummary[]> {
  const { results } = await db
    .prepare('SELECT * FROM lists WHERE user_id = ?1 ORDER BY created_at DESC, id DESC')
    .bind(userId)
    .all<ListRow>();
  const lists = results ?? [];
  if (lists.length === 0) return [];
  const { results: counts } = await db
    .prepare(
      `SELECT list_id, COUNT(*) AS n FROM list_items
        WHERE list_id IN (${lists.map((_, i) => `?${i + 1}`).join(', ')})
        GROUP BY list_id`,
    )
    .bind(...lists.map((l) => l.id))
    .all<{ list_id: number; n: number }>();
  const countById = new Map((counts ?? []).map((c) => [c.list_id, c.n]));
  return lists.map((l) => ({ ...l, itemCount: countById.get(l.id) ?? 0 }));
}

/** Items of a list in position order, with each target resolved for display. */
export async function listListItems(db: D1Database, listId: number): Promise<ListItemView[]> {
  const { results } = await db
    .prepare(
      `SELECT id, list_id AS listId, target_type AS targetType,
              target_id AS targetId, position, note
         FROM list_items
        WHERE list_id = ?1
        ORDER BY position ASC, id ASC`,
    )
    .bind(listId)
    .all<{
      id: number;
      listId: number;
      targetType: ListTargetType;
      targetId: number;
      position: number;
      note: string | null;
    }>();

  const items: ListItemView[] = [];
  for (const r of results ?? []) {
    const resolved = await resolveListItemTarget(db, r.targetType, r.targetId);
    if (!resolved) continue; // target was deleted — skip stale rows
    items.push({ ...r, ...resolved });
  }
  return items;
}

async function resolveListItemTarget(
  db: D1Database,
  targetType: ListTargetType,
  targetId: number,
): Promise<Omit<ListItemView, 'id' | 'listId' | 'targetType' | 'targetId' | 'position' | 'note'> | null> {
  if (targetType === 'book') {
    const book = await getBook(db, targetId);
    if (!book) return null;
    return {
      title: book.title,
      subtitle: `Book · ${book.authors}`,
      imageUrl: book.cover_url,
      href: `/books/${book.id}`,
    };
  }
  const work = await getScreenWork(db, targetId);
  if (!work) return null;
  return {
    title: work.title,
    subtitle: work.kind === 'film' ? 'Film' : 'Series',
    imageUrl: work.poster_url,
    href: `/watch/${work.id}`,
  };
}

/** A list the user owns, or why they can't have it. */
async function ownedList(
  db: D1Database,
  userId: number,
  listId: number,
): Promise<ListRow | NotFoundOrForbidden> {
  const list = await getListById(db, listId);
  if (!list) return 'not_found';
  if (list.user_id !== userId) return 'forbidden';
  return list;
}

// --- writes -----------------------------------------------------------------

export async function createList(
  db: D1Database,
  userId: number,
  input: { title: string; description?: string | null; isPublic?: boolean },
): Promise<{ id: number; slug: string }> {
  let slug = buildSlug(input.title);
  for (let attempt = 0; attempt < 10 && (await slugExists(db, slug)); attempt++) {
    slug = buildSlug(input.title);
  }
  if (await slugExists(db, slug)) {
    throw new Error('Could not generate a unique list slug.');
  }
  const res = await db
    .prepare(
      `INSERT INTO lists (user_id, title, description, is_public, slug)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(
      userId,
      input.title,
      input.description ?? null,
      input.isPublic === false ? 0 : 1,
      slug,
    )
    .run();
  const id = Number(res.meta?.last_row_id);
  if (!Number.isInteger(id) || id < 1) throw new Error('List insert failed.');
  return { id, slug };
}

export async function updateList(
  db: D1Database,
  userId: number,
  listId: number,
  input: { title?: string; description?: string | null; isPublic?: boolean },
): Promise<'ok' | NotFoundOrForbidden> {
  const owned = await ownedList(db, userId, listId);
  if (owned === 'not_found' || owned === 'forbidden') return owned;
  {
    const updates: string[] = ["updated_at = datetime('now')"];
    const params: unknown[] = [];
    let n = 2;
    if (input.title !== undefined) {
      updates.push(`title = ?${n++}`);
      params.push(input.title);
    }
    if (input.description !== undefined) {
      updates.push(`description = ?${n++}`);
      params.push(input.description);
    }
    if (input.isPublic !== undefined) {
      updates.push(`is_public = ?${n++}`);
      params.push(input.isPublic ? 1 : 0);
    }
    await db
      .prepare(`UPDATE lists SET ${updates.join(', ')} WHERE id = ?1`)
      .bind(listId, ...params)
      .run();
    return 'ok';
  }
}

export async function deleteList(
  db: D1Database,
  userId: number,
  listId: number,
): Promise<'ok' | NotFoundOrForbidden> {
  const owned = await ownedList(db, userId, listId);
  if (owned === 'not_found' || owned === 'forbidden') return owned;
  {
    // Items cascade via REFERENCES … ON DELETE CASCADE; the explicit delete
    // keeps behavior identical even if FK enforcement is ever off.
    await db.batch([
      db.prepare('DELETE FROM list_items WHERE list_id = ?1').bind(listId),
      db.prepare('DELETE FROM lists WHERE id = ?1').bind(listId),
    ]);
    return 'ok';
  }
}

export type AddItemResult =
  | { status: 'ok'; id: number }
  | { status: 'not_found' | 'forbidden' | 'target_not_found' | 'duplicate' };

/** Add a target to a list the user owns. Duplicates are rejected (409). */
export async function addItem(
  db: D1Database,
  userId: number,
  listId: number,
  input: { targetType: ListTargetType; targetId: number; note?: string | null },
): Promise<AddItemResult> {
  const owned = await ownedList(db, userId, listId);
  if (owned === 'not_found' || owned === 'forbidden') return { status: owned };

  const exists =
    input.targetType === 'book'
      ? (await getBook(db, input.targetId)) !== null
      : (await getScreenWork(db, input.targetId)) !== null;
  if (!exists) return { status: 'target_not_found' };

  const dupe = await db
    .prepare(
      'SELECT 1 AS one FROM list_items WHERE list_id = ?1 AND target_type = ?2 AND target_id = ?3',
    )
    .bind(listId, input.targetType, input.targetId)
    .first<{ one: number }>();
  if (dupe) return { status: 'duplicate' };

  const res = await db
    .prepare(
      `INSERT INTO list_items (list_id, target_type, target_id, position, note)
       VALUES (?1, ?2, ?3, COALESCE((SELECT MAX(position) FROM list_items WHERE list_id = ?1), -1) + 1, ?4)`,
    )
    .bind(listId, input.targetType, input.targetId, input.note ?? null)
    .run();
  const id = Number(res.meta?.last_row_id);
  if (!Number.isInteger(id) || id < 1) throw new Error('List item insert failed.');
  return { status: 'ok', id };
}

export async function removeItem(
  db: D1Database,
  userId: number,
  listId: number,
  itemId: number,
): Promise<'ok' | NotFoundOrForbidden | 'item_not_found'> {
  const owned = await ownedList(db, userId, listId);
  if (owned === 'not_found' || owned === 'forbidden') return owned;
  const res = await db
    .prepare('DELETE FROM list_items WHERE id = ?1 AND list_id = ?2')
    .bind(itemId, listId)
    .run();
  return (res.meta?.changes ?? 0) > 0 ? 'ok' : 'item_not_found';
}

/**
 * Reorder a list: the given item ids take positions 0..n-1 in that order;
 * any items not mentioned keep their relative order after them. All
 * positions are written in one batch.
 */
export async function reorderItems(
  db: D1Database,
  userId: number,
  listId: number,
  order: number[],
): Promise<'ok' | NotFoundOrForbidden | 'bad_ids'> {
  const owned = await ownedList(db, userId, listId);
  if (owned === 'not_found' || owned === 'forbidden') return owned;

  const { results } = await db
    .prepare('SELECT id FROM list_items WHERE list_id = ?1 ORDER BY position ASC, id ASC')
    .bind(listId)
    .all<{ id: number }>();
  const current = (results ?? []).map((r) => r.id);
  const currentSet = new Set(current);
  if (order.some((id) => !currentSet.has(id)) || new Set(order).size !== order.length) {
    return 'bad_ids';
  }
  const orderedSet = new Set(order);
  const rest = current.filter((id) => !orderedSet.has(id));
  const finalOrder = [...order, ...rest];

  await db.batch(
    finalOrder.map((id, position) =>
      db.prepare('UPDATE list_items SET position = ?1 WHERE id = ?2 AND list_id = ?3').bind(position, id, listId),
    ),
  );
  return 'ok';
}

// --- list-creation rate limiting (20/hour/user) ------------------------------

export const MAX_LISTS_PER_HOUR = 20;

/**
 * Returns true when the user may create another list this hour, and records
 * it. Uses the lists_rate table keyed on (user_id, UTC hour), mirroring the
 * magic_link_rate pattern.
 */
export async function checkListRate(db: D1Database, userId: number): Promise<boolean> {
  const hour = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH (UTC)
  const row = await db
    .prepare('SELECT count FROM lists_rate WHERE user_id = ?1 AND hour = ?2')
    .bind(userId, hour)
    .first<{ count: number }>();
  if ((row?.count ?? 0) >= MAX_LISTS_PER_HOUR) return false;
  await db
    .prepare(
      `INSERT INTO lists_rate (user_id, hour, count) VALUES (?1, ?2, 1)
       ON CONFLICT(user_id, hour) DO UPDATE SET count = count + 1`,
    )
    .bind(userId, hour)
    .run();
  return true;
}
