/**
 * src/search_filters.ts — pure SQL fragment builders for the filtered
 * search statements (src/search.tsx).
 *
 * The three search statements share bind numbering (?1..?5 for the query
 * patterns and limit), so filter placeholders continue at ?6. Each statement
 * binds exactly the values its SQL references — binding a value with no
 * matching placeholder is a hard "column index out of range" error, so the
 * three statements cannot share one bind array:
 *
 * - books:       no filter placeholders, no filter binds
 * - screen_works: kind only, always ?6
 * - adaptations: statuses at ?6.., then kind at ?(6 + statuses.length)
 *
 * Kept in its own import-free module so the placeholder/bind contract is
 * unit-testable without dragging in the app's UI graph.
 */

export interface SearchFilters {
  kind?: string;
  statuses?: string[];
}

export interface FilterFragments {
  /** Appended inside the screen_works WHERE: "" or " AND kind = ?6". */
  worksFilter: string;
  /** Appended inside the adaptations WHERE: "" or " AND …". */
  adaptationFilter: string;
  /** Values for the works statement's filter placeholders, in order. */
  worksBind: unknown[];
  /** Values for the adaptations statement's filter placeholders, in order. */
  adaptationBind: unknown[];
}

export function searchFilterFragments(filters: SearchFilters): FilterFragments {
  const statuses = filters.statuses ?? [];
  const hasKind = filters.kind !== undefined && filters.kind !== '';
  const statusPlaceholders = statuses.map((_, i) => `?${6 + i}`).join(', ');
  const adaptationKindPlaceholder = `?${6 + statuses.length}`;

  const worksFilter = hasKind ? ' AND kind = ?6' : '';

  const adaptationConds: string[] = [];
  if (statuses.length > 0) adaptationConds.push(`a.status IN (${statusPlaceholders})`);
  if (hasKind) adaptationConds.push(`s.kind = ${adaptationKindPlaceholder}`);
  const adaptationFilter =
    adaptationConds.length > 0 ? ` AND ${adaptationConds.join(' AND ')}` : '';

  return {
    worksFilter,
    adaptationFilter,
    worksBind: hasKind ? [filters.kind] : [],
    adaptationBind: [...statuses, ...(hasKind ? [filters.kind] : [])],
  };
}
