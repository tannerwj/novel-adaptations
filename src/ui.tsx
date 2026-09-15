/** @jsxImportSource hono/jsx */
import type { Child } from 'hono/jsx';
import type { AdaptationSummary, Book } from './db';

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
