import type { TradeModeTransactionController } from '../../../hooks/transactions/useTradeTransaction';
import SearchableSelect from '../../SearchableSelect';

interface TradeSearchPanelProps {
  trade: TradeModeTransactionController;
}

export default function TradeSearchPanel({ trade }: TradeSearchPanelProps) {
  return (
    <>
      <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-[1fr_200px_240px_180px]">
        <input
          autoFocus
          value={trade.query}
          onChange={(event) => trade.setQuery(event.target.value)}
          placeholder="Card name or number (e.g. “Charizard” or “025/189”)…"
          className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-base outline-none focus:border-emerald-500"
        />
        <SearchableSelect
          value={trade.language}
          onChange={trade.handleLanguageChange}
          placeholder="Language"
          searchPlaceholder="Search languages"
          options={trade.languageOptions}
        />
        <SearchableSelect
          value={trade.setId}
          onChange={trade.setSetId}
          placeholder={trade.setsLoading ? 'Loading sets...' : 'Any set'}
          searchPlaceholder="Search sets"
          disabled={trade.setsLoading}
          options={trade.sets.map((set) => ({ value: set.id, label: set.name }))}
        />
        <SearchableSelect
          value={trade.rarity}
          onChange={trade.setRarity}
          placeholder="Any rarity"
          searchPlaceholder="Search rarities"
          options={Array.from(new Set([...trade.rarityOptions, trade.rarity].filter(Boolean))).map((rarity) => ({
            value: rarity,
            label: rarity,
          }))}
        />
      </div>

      {(trade.language !== 'english' || trade.setId || trade.rarity || trade.looksLikeNumber) && (
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          {trade.looksLikeNumber && (
            <Chip onClear={() => trade.setQuery('')}>Number: {trade.query.trim()}</Chip>
          )}
          {trade.language !== 'english' && (
            <Chip onClear={() => trade.handleLanguageChange('english')}>
              Language: {trade.languageOptions.find((option) => option.value === trade.language)?.label ?? trade.language}
            </Chip>
          )}
          {trade.setId && (
            <Chip onClear={() => trade.setSetId('')}>
              Set: {trade.sets.find((set) => set.id === trade.setId)?.name ?? trade.setId}
            </Chip>
          )}
          {trade.rarity && <Chip onClear={() => trade.setRarity('')}>Rarity: {trade.rarity}</Chip>}
        </div>
      )}

      {trade.searchError && (
        <div className="mt-4 rounded-lg border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-200">
          {trade.searchError || 'Search failed. Check PkmnPrices settings in Settings → Integrations.'}
        </div>
      )}

      {trade.looksLikeNumber && !trade.setId && (
        <div className="mt-4 rounded-lg border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-200">
          That looks like a card number. Pick a set so we know where to look.
        </div>
      )}

      {!trade.searchEnabled && !trade.looksLikeNumber && (
        <p className="mt-4 text-sm text-slate-500">
          Start typing to search the catalog, or pick a set to browse it.
        </p>
      )}

      {trade.searchFetching && trade.searchEnabled && (
        <p className="mt-4 text-sm text-slate-500">Searching...</p>
      )}

      {!trade.searchFetching && trade.searchEnabled && trade.searchResults.length === 0 && (
        <p className="mt-4 text-sm text-slate-500">No matches.</p>
      )}

      {trade.searchResults.length > 0 && (
        <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {trade.searchResults.map((card) => (
            <li key={card.id}>
              <button
                type="button"
                onClick={() => trade.selectQueuedSearchCard(card)}
                className={`w-full overflow-hidden rounded-xl border text-left transition ${
                  trade.selectedCard?.id === card.id
                    ? 'border-emerald-500 ring-2 ring-emerald-500/40'
                    : 'border-slate-800 bg-slate-900 hover:bg-slate-800'
                }`}
              >
                <div className="aspect-[3/4] bg-slate-800">
                  {card.imageUrl ? (
                    <img
                      src={card.imageUrl}
                      alt={card.name}
                      loading="lazy"
                      className="h-full w-full object-contain"
                    />
                  ) : null}
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
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
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
        x
      </button>
    </span>
  );
}
