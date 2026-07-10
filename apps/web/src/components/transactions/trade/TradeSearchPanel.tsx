import type { TradeModeTransactionController } from '../../../hooks/transactions/useTradeTransaction';
import SearchableSelect from '../../SearchableSelect';
import CardImage from '../CardImage';

interface TradeSearchPanelProps {
  trade: TradeModeTransactionController;
}

/**
 * Trade / Buy search panel.
 *
 * Uses a flex-wrap filter row so filters never overflow their container.
 * The search input remains full-width and always shrinks to fit.
 */
export default function TradeSearchPanel({ trade }: TradeSearchPanelProps) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 shadow-sm">
      <label className="block">
        <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">
          Search catalog
        </span>
        <input
          autoFocus
          value={trade.query}
          onChange={(event) => trade.setQuery(event.target.value)}
          placeholder='Card name or number (e.g. "Charizard" or "025/189")'
          className="min-h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 text-base outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/40"
        />
      </label>

      {/* Fluid filter bar. min-w-0 so children can shrink; basis controls preferred width per breakpoint */}
      <div className="mt-3 flex flex-wrap gap-2">
        <div className="min-w-0 flex-1 basis-full sm:basis-[calc(50%-0.25rem)] lg:basis-[calc(33.333%-0.375rem)]">
          <SearchableSelect
            value={trade.language}
            onChange={trade.handleLanguageChange}
            placeholder="Language"
            searchPlaceholder="Search languages"
            options={trade.languageOptions}
          />
        </div>
        <div className="min-w-0 flex-1 basis-full sm:basis-[calc(50%-0.25rem)] lg:basis-[calc(33.333%-0.375rem)]">
          <SearchableSelect
            value={trade.setId}
            onChange={trade.setSetId}
            placeholder={trade.setsLoading ? 'Loading sets…' : 'Any set'}
            searchPlaceholder="Search sets"
            disabled={trade.setsLoading}
            options={trade.sets.map((set) => ({ value: set.id, label: set.name }))}
          />
        </div>
        <div className="min-w-0 flex-1 basis-full sm:basis-full lg:basis-[calc(33.333%-0.375rem)]">
          <SearchableSelect
            value={trade.rarity}
            onChange={trade.setRarity}
            placeholder="Any rarity"
            searchPlaceholder="Search rarities"
            options={Array.from(
              new Set([...trade.rarityOptions, trade.rarity].filter(Boolean)),
            ).map((rarity) => ({ value: rarity, label: rarity }))}
          />
        </div>
      </div>

      <ActiveFilterChips trade={trade} />

      {trade.searchError && (
        <div className="mt-3 rounded-lg border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-200">
          {trade.searchError || 'Search failed. Check PkmnPrices settings in Settings → Integrations.'}
        </div>
      )}

      {trade.looksLikeNumber && !trade.setId && (
        <div className="mt-3 rounded-lg border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-200">
          That looks like a card number. Pick a set so we know where to look.
        </div>
      )}

      {/* Results / empty / loading region */}
      <SearchResults trade={trade} />
    </div>
  );
}

function ActiveFilterChips({ trade }: { trade: TradeModeTransactionController }) {
  const hasChips =
    trade.language !== 'english' ||
    trade.setId ||
    trade.rarity ||
    trade.looksLikeNumber ||
    !!trade.inferredSetName;
  if (!hasChips) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2 text-xs">
      {trade.looksLikeNumber && (
        <Chip onClear={() => trade.setQuery('')}>Number: {trade.query.trim()}</Chip>
      )}
      {trade.language !== 'english' && (
        <Chip onClear={() => trade.handleLanguageChange('english')}>
          Language:{' '}
          {trade.languageOptions.find((option) => option.value === trade.language)?.label ??
            trade.language}
        </Chip>
      )}
      {trade.setId && (
        <Chip onClear={() => trade.setSetId('')}>
          Set: {trade.sets.find((set) => set.id === trade.setId)?.name ?? trade.setId}
        </Chip>
      )}
      {!trade.setId && trade.inferredSetName && (
        // Inferred set has no clear button — clearing would need the user to
        // remove the set name from their query. The chip is informational.
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-800/60 bg-emerald-950/50 px-2 py-1 text-emerald-200">
          Detected set: {trade.inferredSetName}
        </span>
      )}
      {trade.matchedByArtist && (
        <span className="inline-flex items-center gap-1 rounded-full border border-sky-800/60 bg-sky-950/50 px-2 py-1 text-sky-200">
          Matched by artist
        </span>
      )}
      {trade.rarity && <Chip onClear={() => trade.setRarity('')}>Rarity: {trade.rarity}</Chip>}
    </div>
  );
}

function SearchResults({ trade }: { trade: TradeModeTransactionController }) {
  if (!trade.searchEnabled && !trade.looksLikeNumber) {
    return (
      <div className="mt-4 rounded-xl border border-dashed border-slate-700 bg-slate-950/50 p-6 text-center text-sm text-slate-400">
        Start typing to search the catalog, or pick a set to browse it.
      </div>
    );
  }
  if (trade.searchFetching && trade.searchEnabled) {
    return <p className="mt-4 text-sm text-slate-400">Searching…</p>;
  }
  if (!trade.searchFetching && trade.searchEnabled && trade.searchResults.length === 0) {
    return <p className="mt-4 text-sm text-slate-400">No matches.</p>;
  }
  if (trade.searchResults.length === 0) return null;
  return (
    <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
      {trade.searchResults.map((card) => (
        <li key={card.id}>
          <button
            type="button"
            onClick={() => trade.selectQueuedSearchCard(card)}
            aria-pressed={trade.selectedCard?.id === card.id}
            className={`w-full overflow-hidden rounded-xl border text-left transition ${
              trade.selectedCard?.id === card.id
                ? 'border-emerald-500 ring-2 ring-emerald-500/40'
                : 'border-slate-800 bg-slate-900 hover:border-emerald-500/40 hover:bg-slate-800/80'
            }`}
          >
            <div className="aspect-[3/4] bg-slate-800">
              <CardImage src={card.imageUrl} alt={card.name} />
            </div>
            <div className="p-2">
              <p className="truncate text-sm font-semibold" title={card.name}>
                {card.name}
              </p>
              <p className="truncate text-[11px] text-slate-400">
                {card.setName ?? ''}
                {card.number ? ` • #${card.number}` : ''}
              </p>
              {card.rarity && <p className="truncate text-[11px] text-slate-500">{card.rarity}</p>}
              {card.artist && (
                <p className="truncate text-[11px] text-slate-500" title={card.artist}>
                  Art: {card.artist}
                </p>
              )}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Chip({ onClear, children }: { onClear: () => void; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-800 px-2 py-1 text-slate-200">
      {children}
      <button
        type="button"
        onClick={onClear}
        className="leading-none text-slate-400 hover:text-rose-300"
        aria-label="Clear filter"
      >
        ✕
      </button>
    </span>
  );
}
