/** @jsxImportSource hono/jsx */
/**
 * src/watch_providers.tsx — <WhereToWatch> component + re-exports.
 *
 * The provider fetch/cache logic lives in ./watch_providers_cache.ts (pure
 * TypeScript, unit-tested). This module keeps the JSX component and
 * re-exports the logic so existing import sites keep working.
 */

export {
  fetchWatchProvidersDetailed,
  fetchWatchProviders,
  getWatchProviders,
  fetchAndCacheProviders,
  type WatchProvider,
  type WatchProviders,
  type WaitUntilCtx,
} from './watch_providers_cache';
import type { WatchProvider, WatchProviders } from './watch_providers_cache';

/** One provider group (Stream / Rent / Buy). */
function ProviderGroup({
  title,
  providers,
}: {
  title: string;
  providers: WatchProvider[];
}) {
  if (providers.length === 0) return null;
  return (
    <div style="margin-bottom:1rem">
      <h3
        class="meta"
        style="margin:0 0 0.5rem;text-transform:uppercase;letter-spacing:0.05em"
      >
        {title}
      </h3>
      <ul
        style="list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:0.75rem"
      >
        {providers.map((p) => (
          <li
            key={p.id}
            style="display:flex;align-items:center;gap:0.5rem"
          >
            <img
              src={p.logo}
              alt=""
              width="36"
              height="36"
              loading="lazy"
              style="border-radius:6px"
            />
            <span>{p.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * "Where to watch" section for the screen-work page. Renders nothing
 * (null) when there is no provider data — no broken empty box.
 */
export function WhereToWatch({ data }: { data: WatchProviders | null }) {
  if (!data) return null;
  const hasAny =
    data.flatrate.length > 0 ||
    data.rent.length > 0 ||
    data.buy.length > 0;
  if (!hasAny && !data.link) return null;

  return (
    <section class="panel">
      <h2>Where to watch</h2>
      <ProviderGroup title="Stream" providers={data.flatrate} />
      <ProviderGroup title="Rent" providers={data.rent} />
      <ProviderGroup title="Buy" providers={data.buy} />
      {data.link && (
        <p style="margin:0.5rem 0 0">
          <a
            href={data.link}
            target="_blank"
            rel="noopener noreferrer"
          >
            More options ↗
          </a>
        </p>
      )}
      <p class="meta" style="margin:0.75rem 0 0;font-size:0.8rem">
        Watch provider data via JustWatch
      </p>
    </section>
  );
}

