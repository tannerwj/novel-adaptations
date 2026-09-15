/** @jsxImportSource hono/jsx */
import type { Child } from 'hono/jsx';
import type { AdaptationSummary, Book, NewsItem, NewsStatus, SourceRow } from './db';

const STATUS_COLORS: Record<string, string> = {
  rumored: '#9aa4b2',
  optioned: '#d9a441',
  in_development: '#4f9cf0',
  filming: '#a06cd5',
  post_production: '#e0734f',
  released: '#4caf6d',
  cancelled: '#e05252',
};

export function statusLabel(status: string): string {
  return status.replace(/_/g, ' ');
}

export function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? '#9aa4b2';
  return (
    <span
      class="status-badge"
      style={`background:${color}22;color:${color};border-color:${color}66`}
    >
      {statusLabel(status)}
    </span>
  );
}

function kindLabel(kind: string): string {
  return kind === 'film' ? 'Film' : 'Series';
}

export function Layout({ title, children }: { title: string; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title} — Novel Adaptations</title>
        <style>{`
          :root { color-scheme: dark; }
          body {
            margin: 0;
            font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
            background: #14161b; color: #e8eaf0; line-height: 1.5;
          }
          a { color: #7cc4ff; text-decoration: none; }
          a:hover { text-decoration: underline; }
          header {
            border-bottom: 1px solid #2a2e37; padding: 1rem 1.5rem;
            display: flex; align-items: baseline; gap: 1rem;
          }
          header .brand { font-size: 1.35rem; font-weight: 700; color: #fff; }
          header .tagline { color: #9aa4b2; font-size: .9rem; }
          main { max-width: 900px; margin: 0 auto; padding: 1.5rem; }
          footer {
            border-top: 1px solid #2a2e37; padding: 1rem 1.5rem;
            color: #9aa4b2; font-size: .85rem;
          }
          .cards { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
          .card {
            border: 1px solid #2a2e37; border-radius: 10px; padding: 1rem;
            background: #1b1e25;
          }
          .card h2, .card h3 { margin: 0 0 .25rem; font-size: 1.05rem; }
          .card .meta { color: #9aa4b2; font-size: .9rem; margin: .25rem 0; }
          .status-badge {
            display: inline-block; font-size: .75rem; font-weight: 600;
            padding: .15rem .6rem; border-radius: 999px; border: 1px solid;
            text-transform: capitalize; margin-top: .5rem;
          }
          .detail { display: grid; gap: 1.25rem; }
          .detail section { border: 1px solid #2a2e37; border-radius: 10px; padding: 1.25rem; background: #1b1e25; }
          .detail h2 { margin-top: 0; }
          dl { display: grid; grid-template-columns: 9rem 1fr; gap: .35rem 1rem; margin: 0; }
          dt { color: #9aa4b2; font-size: .9rem; }
          dd { margin: 0; }
          img.cover { max-width: 160px; border-radius: 6px; margin-bottom: .75rem; }
          .tabs { display: flex; gap: .5rem; margin: 1rem 0; }
          .tabs a {
            padding: .4rem .9rem; border: 1px solid #2a2e37; border-radius: 999px;
            color: #9aa4b2; font-size: .9rem;
          }
          .tabs a.active { border-color: #7cc4ff; color: #fff; background: #1b1e25; }
          .queue-item {
            border: 1px solid #2a2e37; border-radius: 10px; padding: 1rem;
            background: #1b1e25; margin-bottom: 1rem;
          }
          .queue-item h3 { margin: 0 0 .35rem; font-size: 1.05rem; }
          .queue-item .meta { color: #9aa4b2; font-size: .85rem; margin: .2rem 0; }
          .queue-item .summary { font-size: .92rem; color: #c9cdd6; margin: .5rem 0; }
          .tier-badge, .flag {
            display: inline-block; font-size: .72rem; font-weight: 700;
            padding: .12rem .55rem; border-radius: 999px; border: 1px solid;
            text-transform: uppercase; letter-spacing: .04em; margin-right: .4rem;
          }
          .tier-trusted { background: #4caf6d22; color: #4caf6d; border-color: #4caf6d66; }
          .tier-reputable { background: #4f9cf022; color: #4f9cf0; border-color: #4f9cf066; }
          .tier-rumor { background: #e0525222; color: #ff7b7b; border-color: #e0525266; }
          .flag-review { background: #d9a44122; color: #d9a441; border-color: #d9a44166; }
          .flag-lowconf { background: #9aa4b222; color: #9aa4b2; border-color: #9aa4b266; }
          .actions { display: flex; flex-wrap: wrap; gap: .6rem; margin-top: .75rem; align-items: center; }
          .actions button, .actions input, .actions select {
            font: inherit; font-size: .85rem; padding: .35rem .7rem;
            border-radius: 6px; border: 1px solid #2a2e37;
            background: #14161b; color: #e8eaf0;
          }
          .actions button { cursor: pointer; background: #242832; }
          .actions button:hover { border-color: #7cc4ff; }
          .actions button.promote { background: #1d3a24; border-color: #4caf6d66; }
          .actions input[type="text"], .actions input[type="url"], .actions input[type="number"] { min-width: 0; }
          table.health { width: 100%; border-collapse: collapse; font-size: .85rem; margin-top: .75rem; }
          table.health th, table.health td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #2a2e37; }
          table.health th { color: #9aa4b2; font-weight: 600; }
          table.health tr.bad td { color: #ff7b7b; }
          .empty { color: #9aa4b2; padding: 2rem 0; text-align: center; }
        `}</style>
      </head>
      <body>
        <header>
          <a class="brand" href="/">
            Novel Adaptations
          </a>
          <span class="tagline">books → screen</span>
        </header>
        <main>{children}</main>
        <footer>
          Novel Adaptations — Phase 1 scaffold. Data model &amp; vision:{' '}
          <a href="/docs/DESIGN.md">docs/DESIGN.md</a> (repo file).
        </footer>
      </body>
    </html>
  );
}

export function HomePage({ adaptations }: { adaptations: AdaptationSummary[] }) {
  return (
    <Layout title="Browse">
      <h1>Adaptations</h1>
      <div class="cards">
        {adaptations.map((a) => (
          <article class="card" key={a.id}>
            {a.book_cover_url && (
              <img class="cover" src={a.book_cover_url} alt={`Cover of ${a.book_title}`} loading="lazy" />
            )}
            <h2>
              <a href={`/adaptations/${a.id}`}>{a.book_title}</a>
            </h2>
            <p class="meta">
              by <a href={`/books/${a.book_id}`}>{a.book_authors}</a>
            </p>
            <p class="meta">
              {kindLabel(a.screen_kind)}: {a.screen_title}
            </p>
            <StatusBadge status={a.status} />
          </article>
        ))}
      </div>
    </Layout>
  );
}

export function AdaptationPage({ adaptation }: { adaptation: AdaptationSummary }) {
  return (
    <Layout title={adaptation.book_title}>
      <p>
        <a href="/">← all adaptations</a>
      </p>
      <div class="detail">
        <section>
          <h2>The book</h2>
          {adaptation.book_cover_url && (
            <img class="cover" src={adaptation.book_cover_url} alt={`Cover of ${adaptation.book_title}`} />
          )}
          <dl>
            <dt>Title</dt>
            <dd>
              <a href={`/books/${adaptation.book_id}`}>{adaptation.book_title}</a>
            </dd>
            <dt>Authors</dt>
            <dd>{adaptation.book_authors}</dd>
          </dl>
        </section>
        <section>
          <h2>The screen work</h2>
          <dl>
            <dt>Title</dt>
            <dd>{adaptation.screen_title}</dd>
            <dt>Kind</dt>
            <dd>{kindLabel(adaptation.screen_kind)}</dd>
            <dt>Release date</dt>
            <dd>{adaptation.screen_release_date ?? '—'}</dd>
          </dl>
        </section>
        <section>
          <h2>Adaptation</h2>
          <dl>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={adaptation.status} />
            </dd>
            <dt>Source</dt>
            <dd>
              {adaptation.source_url ? (
                <a href={adaptation.source_url} rel="noopener noreferrer">
                  {adaptation.source_url}
                </a>
              ) : (
                '—'
              )}
            </dd>
          </dl>
        </section>
      </div>
    </Layout>
  );
}

export function BookPage({ book, adaptations }: { book: Book; adaptations: AdaptationSummary[] }) {
  return (
    <Layout title={book.title}>
      <p>
        <a href="/">← all adaptations</a>
      </p>
      <div class="detail">
        <section>
          <h2>{book.title}</h2>
          {book.cover_url && <img class="cover" src={book.cover_url} alt={`Cover of ${book.title}`} />}
          <dl>
            <dt>Authors</dt>
            <dd>{book.authors}</dd>
            <dt>Published</dt>
            <dd>{book.pub_date ?? '—'}</dd>
            <dt>ISBN</dt>
            <dd>{book.isbn ?? '—'}</dd>
          </dl>
        </section>
        <section>
          <h2>Adaptations ({adaptations.length})</h2>
          <div class="cards">
            {adaptations.map((a) => (
              <article class="card" key={a.id}>
                <h3>
                  <a href={`/adaptations/${a.id}`}>{a.screen_title}</a>
                </h3>
                <p class="meta">{kindLabel(a.screen_kind)}</p>
                <StatusBadge status={a.status} />
              </article>
            ))}
          </div>
        </section>
      </div>
    </Layout>
  );
}

const QUEUE_STATUSES: NewsStatus[] = ['pending', 'approved', 'dismissed'];
const PROMOTE_STATUSES = [
  'rumored',
  'optioned',
  'in_development',
  'filming',
  'post_production',
  'released',
  'cancelled',
];

function tierLabel(tier: string): string {
  return tier === 'rumor' ? 'Rumor' : tier;
}

const QUEUE_SCRIPT = `
const KEY = new URLSearchParams(location.search).get('key') || '';
async function callApi(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Curation-Key': KEY },
    body: JSON.stringify(body || {}),
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) { alert('Error: ' + (data.error || res.status)); return; }
  location.reload();
}
document.querySelectorAll('button[data-act]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const form = btn.closest('form');
    let body = {};
    if (form) {
      const fd = new FormData(form);
      const reason = String(fd.get('reason') || '').trim();
      if (reason) body = { reason };
    }
    callApi(btn.getAttribute('data-path'), body);
  });
});
document.querySelectorAll('form.promote-form').forEach((form) => {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = { adaptation_id: Number(fd.get('adaptation_id')) };
    const st = String(fd.get('status') || '');
    if (st) body.status = st;
    const cu = String(fd.get('corroborating_url') || '').trim();
    if (cu) body.corroborating_url = cu;
    if (!body.adaptation_id) { alert('Enter an adaptation id.'); return; }
    callApi(form.getAttribute('data-path'), body);
  });
});
`;

export function NewsQueuePage({
  status,
  items,
  sources,
  counts,
  keyParam,
}: {
  status: NewsStatus;
  items: NewsItem[];
  sources: SourceRow[];
  counts: Record<NewsStatus, number>;
  keyParam: string;
}) {
  const withKey = (href: string) =>
    keyParam ? `${href}${href.includes('?') ? '&' : '?'}key=${encodeURIComponent(keyParam)}` : href;
  return (
    <Layout title="News curation">
      <h1>News curation</h1>
      <p class="meta">
        Owner-only queue — sorted by trust tier, then confidence. The news
        pipeline proposes; you dispose.
      </p>
      <nav class="tabs">
        {QUEUE_STATUSES.map((s) => (
          <a href={withKey(`/admin/news?status=${s}`)} class={s === status ? 'active' : ''} key={s}>
            {s} ({counts[s] ?? 0})
          </a>
        ))}
      </nav>

      {items.length === 0 ? (
        <p class="empty">Nothing here. The queue is clear.</p>
      ) : (
        items.map((item) => (
          <article class="queue-item" key={item.id}>
            <h3>
              <a href={item.url} rel="noopener noreferrer">
                {item.title}
              </a>
            </h3>
            <p class="meta">
              <span class={`tier-badge tier-${item.trust_tier}`}>{tierLabel(item.trust_tier)}</span>
              {item.needs_review === 1 && <span class="flag flag-review">needs review</span>}
              {(item.confidence ?? 0) < 0.5 && (
                <span class="flag flag-lowconf">low confidence</span>
              )}
            </p>
            <p class="meta">
              {item.source}
              {item.published_at ? ` · ${item.published_at}` : ''} · confidence{' '}
              {Math.round((item.confidence ?? 0) * 100)}%
              {item.llm_model ? ` · ${item.llm_model.replace('@cf/meta/', '')}` : ''}
            </p>
            {(item.book_title || item.author || item.status_signal) && (
              <p class="meta">
                {item.book_title && (
                  <>
                    Book: <strong>{item.book_title}</strong>
                  </>
                )}
                {item.author && <> by {item.author}</>}
                {item.screen_kind && item.screen_kind !== 'unknown' && <> · {item.screen_kind}</>}
                {item.status_signal && item.status_signal !== 'none' && (
                  <> · signal: {item.status_signal}</>
                )}
              </p>
            )}
            {item.summary && <p class="summary">{item.summary}</p>}
            {status === 'pending' && (
              <div class="actions">
                <button type="button" data-act="approve" data-path={`/api/news/${item.id}/approve`}>
                  Approve
                </button>
                <form data-path={`/api/news/${item.id}/dismiss`} style="display:contents">
                  <input type="text" name="reason" placeholder="dismiss reason (optional)" />
                  <button type="button" data-act="dismiss" data-path={`/api/news/${item.id}/dismiss`}>
                    Dismiss
                  </button>
                </form>
                <form
                  class="promote-form"
                  data-path={`/api/news/${item.id}/promote`}
                  style="display:contents"
                >
                  <input
                    type="number"
                    name="adaptation_id"
                    min="1"
                    placeholder="adaptation id"
                    style="width:8rem"
                  />
                  <select name="status" title="explicit status (default: one step forward)">
                    <option value="">auto: next step</option>
                    {PROMOTE_STATUSES.map((s) => (
                      <option value={s} key={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <input
                    type="url"
                    name="corroborating_url"
                    placeholder={
                      item.trust_tier === 'rumor'
                        ? 'corroborating URL (required for rumors)'
                        : 'corroborating URL (optional)'
                    }
                    style="width:14rem"
                  />
                  <button type="submit" class="promote">
                    Promote
                  </button>
                </form>
              </div>
            )}
          </article>
        ))
      )}

      <h2>Feed health</h2>
      {sources.length === 0 ? (
        <p class="meta">No feed runs recorded yet — the next scheduled run populates this.</p>
      ) : (
        <table class="health">
          <thead>
            <tr>
              <th>Feed</th>
              <th>Tier</th>
              <th>Active</th>
              <th>Last fetched</th>
              <th>Status</th>
              <th>Failures</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr class={s.is_active === 0 || s.consecutive_failures > 0 ? 'bad' : ''} key={s.name}>
                <td>{s.name}</td>
                <td>{tierLabel(s.trust_tier)}</td>
                <td>{s.is_active === 1 ? 'yes' : 'PAUSED'}</td>
                <td>{s.last_fetched_at ?? '—'}</td>
                <td>{s.last_status ?? '—'}</td>
                <td>{s.consecutive_failures}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <script dangerouslySetInnerHTML={{ __html: QUEUE_SCRIPT }} />
    </Layout>
  );
}
