/**
 * Trade-In / Buy Intake form.
 *
 * Flow:
 *  1. Operator types the card name (debounced fuzzy search → /api/pkmnprices/search,
 *     proxied server-side so the store's API key never reaches the browser).
 *  2. They pick a card from the result grid. We then pull live per-printing
 *     market prices via /api/pkmnprices/cards/:id/prices.
 *  3. They choose condition, printing, language, quantity, payout (cash vs.
 *     store credit) and optionally override the suggested unit value.
 *  4. "Add to inventory" submits a one-line trade-in to /api/tradeins. The
 *     server upserts the product+SKU, finalizes the trade, and writes an
 *     `inventory` row at the current location. Trades over the approval
 *     threshold stay `pending_approval`; everything else is on-hand
 *     immediately.
 *
 * Why not a separate "buy intake" endpoint: trade-in already does all of
 * this and gives us audit history + customer store credit + manager
 * approval for free. The "buy" framing is just the cash-payout variant.
 */
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CardCondition, CardLanguage, CardPrinting, PayoutKind } from '@tcg/shared';
import { api } from '../lib/api';
import { useSession } from '../hooks/useSession';
import { useDebounced } from '../hooks/useBarcodeScanner';
import SearchableSelect from '../components/SearchableSelect';

type TcgapiCard = {
  id: string;
  name: string;
  number: string | null;
  rarity: string | null;
  imageUrl: string | null;
  setId: string | null;
  setName: string | null;
  gameSlug: string | null;
  gameName: string | null;
};

type SearchResponse = {
  results: TcgapiCard[];
  page: number;
  perPage: number;
  hasMore: boolean;
  total: number | null;
};

type SetRow = { id: string; name: string; slug?: string };
type SetsResponse = { sets: SetRow[] };

// Fixed language axis — PkmnPrices `language` accepts these string values.
// English/Japanese only, plus a placeholder for future European additions.
const LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'english', label: 'English' },
  { value: 'japanese', label: 'Japanese (Pro tier)' },
];

// Matches numeric and alphanumeric card numbers: "25", "025/189", "XY133", "SVP 075".
// Requires at least one digit so ordinary name searches like "Charizard" stay name searches.
const NUMBER_QUERY_RE = /^(?=.*\d)[a-z0-9#\-\s]+(\s*\/\s*[a-z0-9#\-\s]+)?$/i;

type PriceRow = {
  cardId: string;
  printing: string;
  marketCents: number | null;
  lowCents: number | null;
  medianCents: number | null;
  buylistCents: number | null;
  lastUpdatedAt: string | null;
};

type PricesResponse = { cardId: string; prices: PriceRow[] };

type CreateTradeResponse = {
  id: string;
  status: string;
  totalValueCents: number;
  skuIds: { skuId: string; quantity: number }[];
};

type QueuedTradeItem = {
  id: string;
  tcgapiProductId: string;
  name: string;
  imageSourceUrl: string | null;
  rarity: string | null;
  condition: CardCondition;
  printing: CardPrinting;
  language: CardLanguage;
  quantity: number;
  payoutModifierPercent: number;
  overrideValueCents?: number;
  marketPriceCents: number | null;
  estimatedUnitValueCents: number;
};

const CONDITIONS: CardCondition[] = ['NM', 'LP', 'MP', 'HP', 'DMG'];
const PRINTINGS: CardPrinting[] = ['Normal', 'Foil', 'Reverse', 'Holo', 'FirstEdition'];
const LANGUAGES: CardLanguage[] = ['EN', 'JP', 'DE', 'FR', 'IT', 'ES', 'PT', 'KO', 'CN'];

const GRADING_COMPANIES = ['PSA', 'CGC', 'Beckett', 'TAG'] as const;
type GradingCompany = (typeof GRADING_COMPANIES)[number];

const GRADE_OPTIONS: Record<GradingCompany, string[]> = {
  PSA: ['10', '9', '8.5', '8', '7.5', '7', '6', '5', '4', '3', '2', '1.5', '1'],
  CGC: ['10', '9.5', '9', '8.5', '8', '7.5', '7', '6.5', '6', '5.5', '5', '4.5', '4', '3.5', '3', '2.5', '2', '1.5', '1'],
  Beckett: ['10', '9.5', '9', '8.5', '8', '7.5', '7', '6.5', '6', '5.5', '5', '4.5', '4', '3', '2', '1'],
  TAG: ['10', '9', '8', '7', '6', '5', '4', '3', '2', '1'],
};

// Multipliers mirror the server's `PAYOUT_MULTIPLIERS` in tradeins.ts. Kept
// in sync manually because exporting them from the server would drag the
// API workspace into the web bundle. Only used for the on-screen suggested
// value preview; the server recomputes authoritatively on submit.
const PAYOUT_MULTIPLIERS: Record<PayoutKind, number> = {
  cash: 0.7,
  store_credit: 0.8,
};

function pickPricingRow(prices: PriceRow[] | undefined, printing: CardPrinting): PriceRow | undefined {
  if (!prices?.length) return undefined;
  return (
    prices.find((p) => tcgapiPrintingToEnum(p.printing) === printing) ??
    prices.find((p) => (p.marketCents ?? 0) > 0) ??
    prices[0]
  );
}

/**
 * Map tcgapi's freeform printing labels ("Holofoil", "Reverse Holofoil",
 * "1st Edition Normal", …) to our enum. Mirrors `toPrinting` in
 * inventory-import.ts.
 */
function tcgapiPrintingToEnum(label: string): CardPrinting {
  const n = label.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!n) return 'Normal';
  if (n.includes('reverseholo') || n === 'reverse' || n === 'rh') return 'Reverse';
  if (n.includes('1stedition') || n.includes('firstedition')) return 'FirstEdition';
  if (n.includes('holo')) return 'Holo';
  if (n.includes('foil') && !n.includes('non')) return 'Foil';
  if (n.includes('nonfoil') || n.includes('normal') || n === 'regular') return 'Normal';
  return 'Normal';
}

function formatCents(c: number | null | undefined): string {
  if (c == null) return '—';
  return `$${(c / 100).toFixed(2)}`;
}

/**
 * Build a QR-code label sheet PDF for the freshly-created SKUs and open it
 * in a new tab. The browser's PDF viewer is responsible for the print
 * dialog — that keeps us out of platform-specific printer drivers and lets
 * the user pick the right printer + label sheet on their own machine.
 *
 * Each SKU gets `quantity` copies so a 3× trade-in produces 3 labels.
 */
async function printQrLabels(
  skuIds: { skuId: string; quantity: number }[],
  cardName: string,
): Promise<void> {
  for (const { skuId, quantity } of skuIds) {
    for (let copy = 0; copy < Math.max(1, quantity); copy += 1) {
      const blob = await api.postBlob('/skus/labels.pdf', {
        format: 'qr',
        sheet: 'nelko14x40',
        items: [{ skuId, copies: 1 }],
      });
      const url = URL.createObjectURL(blob);
      const win = window.open(url, '_blank', 'noopener,noreferrer');
      if (!win) {
        // Popup blocked — fall back to a download so the operator still gets the label.
        const a = document.createElement('a');
        a.href = url;
        a.download = `qr-labels-${cardName.replace(/[^a-z0-9]+/gi, '-').slice(0, 32)}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      // Delay so the load can complete first before the next label job.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }
}

function suggestedUnitValueCents(
  prices: PriceRow[] | undefined,
  printing: CardPrinting,
  condition: CardCondition,
  payout: PayoutKind,
  payoutModifierPercent: number,
): number {
  const match = pickPricingRow(prices, printing);
  if (!match) return 0;
  const candidates = [match.marketCents, match.medianCents].filter(
    (n): n is number => typeof n === 'number' && n > 0,
  );
  const base = candidates.length ? Math.min(...candidates) : 0;
  void condition;
  const payoutBase = Math.max(0, Math.floor(base * PAYOUT_MULTIPLIERS[payout]));
  return Math.max(0, Math.floor(payoutBase * (1 + payoutModifierPercent / 100)));
}

function sameQueuedItemIdentity(a: QueuedTradeItem, b: QueuedTradeItem): boolean {
  return (
    a.tcgapiProductId === b.tcgapiProductId &&
    a.condition === b.condition &&
    a.printing === b.printing &&
    a.language === b.language &&
    a.marketPriceCents === b.marketPriceCents &&
    a.payoutModifierPercent === b.payoutModifierPercent &&
    (a.overrideValueCents ?? null) === (b.overrideValueCents ?? null)
  );
}

export default function TradeInPage() {
  const session = useSession();
  const [q, setQ] = useState('');
  // Language replaces the old game selector — PkmnPrices is Pokémon-only, so
  // the useful axis is which language of card to browse.
  const [language, setLanguage] = useState<string>('english');
  const [setId, setSetId] = useState<string>('');
  const [rarity, setRarity] = useState<string>('');
  const [selected, setSelected] = useState<TcgapiCard | null>(null);
  const [queuedItems, setQueuedItems] = useState<QueuedTradeItem[]>([]);
  const debounced = useDebounced(q, 300);
  const debouncedRarity = useDebounced(rarity, 300);

  // If the operator types something that looks like a card number
  // ("025", "025/189", "XY133"), use it as the `number` filter. Otherwise treat
  // it as a name search.
  const looksLikeNumber = NUMBER_QUERY_RE.test(debounced.trim());
  const numberParam = looksLikeNumber ? debounced.trim() : '';
  const nameParam = looksLikeNumber ? '' : debounced.trim();

  const sets = useQuery<SetsResponse>({
    queryKey: ['pkmnprices.sets', language],
    queryFn: () =>
      api.get<SetsResponse>(`/pkmnprices/sets?language=${encodeURIComponent(language)}`),
    enabled: !!language,
    staleTime: 24 * 60 * 60_000,
  });

  // Reset selected set when language changes: set IDs are language-scoped upstream.
  const onLanguageChange = (next: string) => {
    setLanguage(next);
    setSetId('');
  };

  // Enabled when: name search ≥ 2 chars, OR a number is being searched
  // (within a set), OR a set is selected (browse mode).
  const searchEnabled =
    nameParam.length >= 2 ||
    (!!numberParam && !!setId) ||
    !!setId;

  const search = useQuery<SearchResponse>({
    queryKey: ['pkmnprices.search', { nameParam, numberParam, language, setId, debouncedRarity }],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams();
      if (nameParam) params.set('q', nameParam);
      if (numberParam) params.set('number', numberParam);
      if (language) params.set('language', language);
      if (setId) params.set('setId', setId);
      params.set('perPage', '24');
      return api.get<SearchResponse>(`/pkmnprices/search?${params.toString()}`, { signal });
    },
    enabled: searchEnabled,
    staleTime: 60_000,
  });

  // Client-side rarity filter — PkmnPrices doesn't accept `rarity` upstream,
  // so post-filter on the returned page.
  const filteredResults = useMemo(() => {
    const all = search.data?.results ?? [];
    if (!debouncedRarity.trim()) return all;
    const needle = debouncedRarity.trim().toLowerCase();
    return all.filter((c) => c.rarity?.toLowerCase().includes(needle));
  }, [search.data, debouncedRarity]);

  // Collect unique rarities from the current result set for the dropdown.
  const rarityOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const c of search.data?.results ?? []) {
      if (c.rarity) seen.add(c.rarity);
    }
    return Array.from(seen).sort();
  }, [search.data]);

  const needsSetScope = !!numberParam && !setId;

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Trade-In / Buy Intake</h1>
        <p className="text-sm text-slate-400">
          Search the PkmnPrices.com catalog by card name, by number (e.g.{' '}
          <code className="px-1 rounded bg-slate-800">025/189</code> — pick a set first), or browse
          a set. Then choose a printing, payout, and add to inventory.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_200px_240px_180px] gap-2">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Card name or number (e.g. “Charizard” or “025/189”)…"
          className="bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-base outline-none focus:border-emerald-500"
        />
        <SearchableSelect
          value={language}
          onChange={onLanguageChange}
          placeholder="Language"
          searchPlaceholder="Search languages"
          options={LANGUAGE_OPTIONS}
        />
        <SearchableSelect
          value={setId}
          onChange={setSetId}
          placeholder={sets.isLoading ? 'Loading sets...' : 'Any set'}
          searchPlaceholder="Search sets"
          disabled={sets.isLoading}
          options={(sets.data?.sets ?? []).map((s) => ({ value: s.id, label: s.name }))}
        />
        <SearchableSelect
          value={rarity}
          onChange={setRarity}
          placeholder="Any rarity"
          searchPlaceholder="Search rarities"
          options={Array.from(new Set([...rarityOptions, rarity].filter(Boolean))).map((r) => ({
            value: r,
            label: r,
          }))}
        />
      </div>

      {(language !== 'english' || setId || rarity || numberParam) && (
        <div className="flex flex-wrap gap-2 text-xs">
          {numberParam && (
            <Chip onClear={() => setQ('')}>Number: {numberParam}</Chip>
          )}
          {language !== 'english' && (
            <Chip onClear={() => onLanguageChange('english')}>
              Language: {LANGUAGE_OPTIONS.find((l) => l.value === language)?.label ?? language}
            </Chip>
          )}
          {setId && (
            <Chip onClear={() => setSetId('')}>
              Set: {sets.data?.sets.find((s) => s.id === setId)?.name ?? setId}
            </Chip>
          )}
          {rarity && <Chip onClear={() => setRarity('')}>Rarity: {rarity}</Chip>}
        </div>
      )}

      {search.isError && (
        <div className="bg-rose-950/40 border border-rose-800 rounded-lg p-3 text-sm text-rose-200">
          {(search.error as Error).message ||
            'Search failed. Check PkmnPrices settings in Settings → Integrations.'}
        </div>
      )}

      {needsSetScope && (
        <div className="bg-amber-950/40 border border-amber-800 rounded-lg p-3 text-sm text-amber-200">
          That looks like a card number. Pick a set so we know where to look.
        </div>
      )}

      {!searchEnabled && !needsSetScope && (
        <p className="text-sm text-slate-500">
          Start typing to search the catalog, or pick a set to browse it.
        </p>
      )}

      {searchEnabled && search.isFetching && (
        <p className="text-sm text-slate-500">Searching…</p>
      )}

      {!search.isFetching && searchEnabled && filteredResults.length === 0 && (
        <p className="text-sm text-slate-500">No matches.</p>
      )}

      {filteredResults.length > 0 && (
        <ul className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {filteredResults.map((card) => (
            <li key={card.id}>
              <button
                type="button"
                onClick={() => setSelected(card)}
                className={`w-full text-left bg-slate-900 hover:bg-slate-800 border ${
                  selected?.id === card.id
                    ? 'border-emerald-500 ring-2 ring-emerald-500/40'
                    : 'border-slate-800'
                } rounded-xl overflow-hidden transition`}
              >
                <div className="aspect-[3/4] bg-slate-800 flex items-center justify-center">
                  {card.imageUrl ? (
                    <img
                      src={card.imageUrl}
                      alt={card.name}
                      loading="lazy"
                      className="w-full h-full object-contain"
                    />
                  ) : (
                    <span className="text-xs text-slate-500">No image</span>
                  )}
                </div>
                <div className="p-2">
                  <div className="text-sm font-semibold leading-tight truncate" title={card.name}>
                    {card.name}
                  </div>
                  <div className="text-[11px] text-slate-400 truncate">
                    {card.setName ?? card.gameName ?? ''}
                    {card.number ? ` · #${card.number}` : ''}
                  </div>
                  {card.rarity && (
                    <div className="text-[11px] text-slate-500 truncate">{card.rarity}</div>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      <IntakeDetail
        card={selected}
        locationId={session.locationId}
        queuedItems={queuedItems}
        setQueuedItems={setQueuedItems}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

interface IntakeDetailProps {
  card: TcgapiCard | null;
  locationId: string | null;
  queuedItems: QueuedTradeItem[];
  setQueuedItems: Dispatch<SetStateAction<QueuedTradeItem[]>>;
  onClose: () => void;
}

function IntakeDetail({ card, locationId, queuedItems, setQueuedItems, onClose }: IntakeDetailProps) {
  const open = !!card;
  return (
    <>
      {/* Backdrop — click outside to close. Hidden when closed so it doesn't
          eat clicks. */}
      <div
        onClick={onClose}
        className={`fixed inset-0 bg-slate-950/60 z-30 transition-opacity ${
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        aria-hidden={!open}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Trade-in intake"
        className={`fixed inset-y-0 right-0 z-40 w-full sm:w-[480px] lg:w-[560px] bg-slate-900 border-l border-slate-800 shadow-2xl flex flex-col transition-transform ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {open && card && (
          <IntakeDetailBody
            card={card}
            locationId={locationId}
            queuedItems={queuedItems}
            setQueuedItems={setQueuedItems}
            onClose={onClose}
          />
        )}
      </aside>
    </>
  );
}

function IntakeDetailBody({
  card,
  locationId,
  queuedItems,
  setQueuedItems,
  onClose,
}: {
  card: TcgapiCard;
  locationId: string | null;
  queuedItems: QueuedTradeItem[];
  setQueuedItems: Dispatch<SetStateAction<QueuedTradeItem[]>>;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [activeCard, setActiveCard] = useState<TcgapiCard>(card);
  const [isGraded, setIsGraded] = useState(false);
  const [gradingCompany, setGradingCompany] = useState<GradingCompany>('PSA');
  const [gradedGrade, setGradedGrade] = useState('10');
  const [condition, setCondition] = useState<CardCondition>('NM');
  const [printing, setPrinting] = useState<CardPrinting>('Normal');
  const [language, setLanguage] = useState<CardLanguage>('EN');
  const [quantity, setQuantity] = useState(1);
  const [payout, setPayout] = useState<PayoutKind>('cash');
  const [payoutModifierPercent, setPayoutModifierPercent] = useState<string>('0');
  const [overrideValue, setOverrideValue] = useState<string>('');
  const [submitMsg, setSubmitMsg] = useState<string | null>(null);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [labelInfo, setLabelInfo] = useState<{
    skuIds: { skuId: string; quantity: number }[];
    cardName: string;
  } | null>(null);
  const [labelErr, setLabelErr] = useState<string | null>(null);
  const [printingLabels, setPrintingLabels] = useState(false);

  useEffect(() => {
    setActiveCard(card);
    setCondition('NM');
    setPrinting('Normal');
    setLanguage('EN');
    setQuantity(1);
    setPayoutModifierPercent('0');
    setOverrideValue('');
    setIsGraded(false);
    setSubmitMsg(null);
    setSubmitErr(null);
    setLabelErr(null);
  }, [card]);

  const prices = useQuery<PricesResponse>({
    queryKey: ['tcgapi.prices', activeCard.id],
    queryFn: () => api.get<PricesResponse>(`/pkmnprices/cards/${encodeURIComponent(activeCard.id)}/prices`),
    staleTime: 5 * 60_000,
  });

  const variants = useQuery<SearchResponse>({
    queryKey: ['tcgapi.variants', activeCard.setId, activeCard.name],
    queryFn: () => {
      const params = new URLSearchParams({ q: activeCard.name, perPage: '50' });
      if (activeCard.setId) params.set('setId', activeCard.setId);
      return api.get<SearchResponse>(`/pkmnprices/search?${params.toString()}`);
    },
    enabled: !!activeCard.setId,
    staleTime: 5 * 60_000,
  });

  const rarityVariants = useMemo(() => {
    const seen = new Map<string, TcgapiCard>();
    for (const v of variants.data?.results ?? []) {
      const key = v.rarity ?? 'Unknown';
      if (!seen.has(key)) seen.set(key, v);
    }
    return Array.from(seen.values());
  }, [variants.data]);

  const ebayGradedUrl = useMemo(() => {
    if (!isGraded) return null;
    const q = encodeURIComponent(`${activeCard.name} ${gradingCompany} ${gradedGrade}`);
    return `https://www.ebay.com/sch/i.html?_nkw=${q}&LH_Complete=1&LH_Sold=1`;
  }, [isGraded, activeCard.name, gradingCompany, gradedGrade]);

  const suggested = useMemo(
    () =>
      suggestedUnitValueCents(
        prices.data?.prices,
        printing,
        condition,
        payout,
        Number(payoutModifierPercent) || 0,
      ),
    [prices.data, printing, condition, payout, payoutModifierPercent],
  );

  const payoutModifier = useMemo(() => {
    const n = Number(payoutModifierPercent);
    return Number.isFinite(n) ? n : 0;
  }, [payoutModifierPercent]);

  const overrideCents = useMemo(() => {
    const v = overrideValue.trim();
    if (!v) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 100);
  }, [overrideValue]);

  const effectiveCents = overrideCents ?? suggested;
  const selectedPriceRow = useMemo(
    () => pickPricingRow(prices.data?.prices, printing),
    [prices.data?.prices, printing],
  );
  const selectedMarketPriceCents = selectedPriceRow?.marketCents ?? null;

  const itemsTotalPayoutCents = useMemo(
    () => queuedItems.reduce((sum, item) => sum + item.estimatedUnitValueCents * item.quantity, 0),
    [queuedItems],
  );

  const pendingLineTotalCents = effectiveCents * quantity;
  const projectedTradeTotalCents = itemsTotalPayoutCents + pendingLineTotalCents;

  function addCurrentToBatch() {
    setSubmitMsg(null);
    setSubmitErr(null);
    setLabelInfo(null);
    setLabelErr(null);

    const next: QueuedTradeItem = {
      id: crypto.randomUUID(),
      tcgapiProductId: activeCard.id,
      name: activeCard.name,
      imageSourceUrl: activeCard.imageUrl,
      rarity: activeCard.rarity,
      condition,
      printing,
      language,
      quantity,
      payoutModifierPercent: payoutModifier,
      overrideValueCents: overrideCents ?? undefined,
      marketPriceCents: selectedMarketPriceCents,
      estimatedUnitValueCents: effectiveCents,
    };

    setQueuedItems((prev) => {
      const idx = prev.findIndex((i) => sameQueuedItemIdentity(i, next));
      if (idx === -1) return [...prev, next];
      return prev.map((i, iIdx) =>
        iIdx === idx ? { ...i, quantity: i.quantity + next.quantity } : i,
      );
    });

    setQuantity(1);
    setOverrideValue('');
    setPayoutModifierPercent('0');
  }

  function removeQueuedItem(id: string) {
    setQueuedItems((prev) => prev.filter((item) => item.id !== id));
  }

  function clearQueuedItems() {
    setQueuedItems([]);
    setSubmitMsg(null);
    setSubmitErr(null);
    setLabelInfo(null);
    setLabelErr(null);
  }

  const add = useMutation({
    mutationFn: async () => {
      if (!locationId) throw new Error('Pick a location first.');
      if (queuedItems.length === 0) throw new Error('Add at least one item to the trade.');
      const body = {
        locationId,
        payout,
        items: queuedItems.map((item) => ({
          tcgapiProductId: item.tcgapiProductId,
          name: item.name,
          imageSourceUrl: item.imageSourceUrl,
          rarity: item.rarity ?? undefined,
          game: 'other' as const,
          condition: item.condition,
          printing: item.printing,
          language: item.language,
          quantity: item.quantity,
          payoutModifierPercent: item.payoutModifierPercent,
          overrideValueCents: item.overrideValueCents,
          marketPriceCents: item.marketPriceCents,
        })),
      };
      return api.post<CreateTradeResponse>('/tradeins', body);
    },
    onSuccess: (data) => {
      const submittedItems = [...queuedItems];
      setSubmitErr(null);
      setLabelErr(null);
      const dollars = (data.totalValueCents / 100).toFixed(2);
      const totalCards = submittedItems.reduce((sum, item) => sum + item.quantity, 0);
      const distinctLines = submittedItems.length;
      setSubmitMsg(
        data.status === 'pending_approval'
          ? `Created trade ${data.id.slice(0, 8)}… for $${dollars} (${totalCards} card${totalCards === 1 ? '' : 's'} across ${distinctLines} line${distinctLines === 1 ? '' : 's'}) — needs manager approval before it lands in inventory.`
          : `Added ${totalCards} card${totalCards === 1 ? '' : 's'} across ${distinctLines} line${distinctLines === 1 ? '' : 's'} to inventory. Payout $${dollars}.`,
      );
      qc.invalidateQueries({ queryKey: ['products'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
      setQueuedItems([]);
      // Once a SKU exists, surface a print-labels affordance. We auto-trigger
      // a print only when the trade actually landed in inventory; pending
      // trades wait for manager approval before a label makes sense.
      if (data.skuIds?.length) {
        const firstCardName = submittedItems[0]?.name ?? activeCard.name;
        setLabelInfo({ skuIds: data.skuIds, cardName: firstCardName });
        if (data.status !== 'pending_approval') {
          // Fire-and-forget; user sees the result via the print dialog.
          // If popup-blocked, the manual button below still works.
          void printQrLabels(data.skuIds, firstCardName).catch((e) =>
            setLabelErr(e instanceof Error ? e.message : String(e)),
          );
        }
      }
    },
    onError: (e: unknown) => {
      setSubmitErr(e instanceof Error ? e.message : String(e));
      setSubmitMsg(null);
      setLabelInfo(null);
    },
  });

  const onPrintLabels = async () => {
    if (!labelInfo) return;
    setPrintingLabels(true);
    setLabelErr(null);
    try {
      await printQrLabels(labelInfo.skuIds, labelInfo.cardName);
    } catch (e) {
      setLabelErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPrintingLabels(false);
    }
  };

  return (
    <>
      {/* Sticky header keeps Close button visible while body scrolls. */}
      <header className="flex items-start justify-between gap-2 p-4 border-b border-slate-800">
        <div className="min-w-0">
          <h2 className="text-lg font-bold truncate" title={activeCard.name}>
            {activeCard.name}
          </h2>
          <p className="text-xs text-slate-400 truncate">
            {[activeCard.setName, activeCard.gameName, activeCard.number ? `#${activeCard.number}` : null, activeCard.rarity]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 text-slate-400 hover:text-slate-200 -m-1 p-1"
          aria-label="Close"
        >
          ✕
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div className="flex gap-3">
          <div className="w-32 shrink-0">
            <div className="aspect-[3/4] bg-slate-800 rounded-lg overflow-hidden flex items-center justify-center">
              {activeCard.imageUrl ? (
                <img
                  src={activeCard.imageUrl}
                  alt={activeCard.name}
                  className="w-full h-full object-contain"
                />
              ) : (
                <span className="text-xs text-slate-500">No image</span>
              )}
            </div>
          </div>
        </div>

        <div>
          <h3 className="text-xs uppercase tracking-wide text-slate-400 mb-2">Market prices</h3>
          {prices.isLoading ? (
            <p className="text-sm text-slate-500">Loading prices…</p>
          ) : prices.isError ? (
            <p className="text-sm text-rose-300">
              {(prices.error as Error).message || 'Could not fetch prices.'}
            </p>
          ) : (prices.data?.prices.length ?? 0) === 0 ? (
            <p className="text-sm text-slate-500">No pricing available.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-slate-400 text-left">
                  <tr>
                    <th className="font-medium pb-1">Printing</th>
                    <th className="font-medium pb-1 text-right">Market</th>
                    <th className="font-medium pb-1 text-right">Median</th>
                    <th className="font-medium pb-1 text-right">Low</th>
                    <th className="font-medium pb-1 text-right">Buylist</th>
                  </tr>
                </thead>
                <tbody>
                  {prices.data!.prices.map((p, i) => (
                    <tr
                      key={`${p.printing}-${i}`}
                      className="border-t border-slate-800 text-slate-200"
                    >
                      <td className="py-1">{p.printing}</td>
                      <td className="py-1 text-right font-mono">{formatCents(p.marketCents)}</td>
                      <td className="py-1 text-right font-mono">{formatCents(p.medianCents)}</td>
                      <td className="py-1 text-right font-mono">{formatCents(p.lowCents)}</td>
                      <td className="py-1 text-right font-mono">{formatCents(p.buylistCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {rarityVariants.length > 1 && (
          <div>
            <h3 className="text-xs uppercase tracking-wide text-slate-400 mb-2">Rarity variant</h3>
            <div className="flex flex-wrap gap-2">
              {rarityVariants.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => {
                    setActiveCard(v);
                    setCondition('NM');
                    setPrinting('Normal');
                    setSubmitMsg(null);
                    setSubmitErr(null);
                    setLabelInfo(null);
                    setOverrideValue('');
                  }}
                  className={`text-xs px-2.5 py-1 rounded-full border transition ${
                    activeCard.id === v.id
                      ? 'bg-emerald-500 border-emerald-500 text-slate-900 font-semibold'
                      : 'bg-slate-800 border-slate-700 text-slate-200 hover:border-emerald-500'
                  }`}
                >
                  {v.rarity ?? 'Unknown'}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Graded card section */}
        <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-slate-300">
          <input
            type="checkbox"
            checked={isGraded}
            onChange={(e) => setIsGraded(e.target.checked)}
            className="rounded accent-emerald-500"
          />
          Graded card (PSA / CGC / Beckett / TAG)
        </label>

        {isGraded && (
          <div className="bg-slate-950 border border-slate-700 rounded-xl p-3 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Grading company">
                <select
                  value={gradingCompany}
                  onChange={(e) => {
                    setGradingCompany(e.target.value as GradingCompany);
                    setGradedGrade('10');
                  }}
                  className="input"
                >
                  {GRADING_COMPANIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </Field>
              <Field label="Grade">
                <select
                  value={gradedGrade}
                  onChange={(e) => setGradedGrade(e.target.value)}
                  className="input"
                >
                  {GRADE_OPTIONS[gradingCompany].map((g) => (
                    <option key={g} value={g}>{gradingCompany} {g}</option>
                  ))}
                </select>
              </Field>
            </div>
            {ebayGradedUrl && (
              <a
                href={ebayGradedUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 underline-offset-2 underline"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                View {gradingCompany} {gradedGrade} recently sold on eBay
              </a>
            )}
            <p className="text-[11px] text-slate-500">
              Graded card prices vary by pop report — use Override unit value to set the exact payout.
            </p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Condition">
            <select
              value={condition}
              onChange={(e) => setCondition(e.target.value as CardCondition)}
              className="input"
            >
              {CONDITIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Printing">
            <select
              value={printing}
              onChange={(e) => setPrinting(e.target.value as CardPrinting)}
              className="input"
            >
              {PRINTINGS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Language">
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value as CardLanguage)}
              className="input"
            >
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Quantity">
            <input
              type="number"
              min={1}
              step={1}
              value={quantity}
              onChange={(e) => setQuantity(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
              className="input"
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
          <Field label="Payout">
            <div className="flex gap-2">
              {(['cash', 'store_credit'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPayout(p)}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm border ${
                    payout === p
                      ? 'bg-emerald-500 text-slate-900 border-emerald-500 font-semibold'
                      : 'bg-slate-950 border-slate-700 text-slate-300'
                  }`}
                >
                  {p === 'cash' ? 'Cash' : 'Store credit'}
                </button>
              ))}
            </div>
          </Field>
          <Field
            label="Modifier %"
            hint="Applies after the base payout percentage. Positive increases payout; negative reduces it."
          >
            <input
              type="number"
              step="0.1"
              value={payoutModifierPercent}
              onChange={(e) => setPayoutModifierPercent(e.target.value)}
              placeholder="0"
              className="input"
            />
          </Field>
          <Field
            label={`Suggested unit value (${payout === 'cash' ? 'cash' : 'credit'})`}
            hint={`Computed from the lowest of market/median × payout multiplier${payoutModifier ? ` × ${((1 + payoutModifier / 100) * 100).toFixed(1)}%` : ''}.`}
          >
            <div className="input bg-slate-950 text-slate-200 font-mono">
              {formatCents(suggested)}
            </div>
          </Field>
          <Field label="Override unit value ($)" hint="Optional — leave blank to use suggested.">
            <input
              type="number"
              min={0}
              step="0.01"
              value={overrideValue}
              onChange={(e) => setOverrideValue(e.target.value)}
              placeholder="0.00"
              className="input"
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-950 border border-slate-700 rounded-lg p-3">
          <div className="text-xs text-slate-300">
            Pending line total: <span className="font-mono text-emerald-300">{formatCents(pendingLineTotalCents)}</span>
            <span className="text-slate-500"> ({quantity} × {formatCents(effectiveCents)})</span>
          </div>
          <button
            type="button"
            onClick={addCurrentToBatch}
            disabled={quantity < 1}
            className="text-xs bg-emerald-500 hover:bg-emerald-400 text-slate-900 font-semibold rounded-md px-3 py-1.5 disabled:bg-slate-700 disabled:text-slate-400"
          >
            Add line item
          </button>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs uppercase tracking-wide text-slate-400">Trade batch</h3>
            {queuedItems.length > 0 && (
              <button
                type="button"
                onClick={clearQueuedItems}
                className="text-xs text-slate-400 hover:text-rose-300"
              >
                Clear all
              </button>
            )}
          </div>
          {queuedItems.length === 0 ? (
            <p className="text-sm text-slate-500">No line items yet. Configure the card and click Add line item.</p>
          ) : (
            <ul className="space-y-2">
              {queuedItems.map((item) => (
                <li
                  key={item.id}
                  className="rounded-lg border border-slate-700 bg-slate-950/70 p-2.5 flex items-start justify-between gap-2"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-slate-100 truncate" title={item.name}>{item.name}</p>
                    <p className="text-[11px] text-slate-400">
                      {item.condition} / {item.printing} / {item.language}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      {item.quantity} × {formatCents(item.estimatedUnitValueCents)}
                      {item.overrideValueCents != null ? ' (override)' : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-mono text-xs text-emerald-300">
                      {formatCents(item.estimatedUnitValueCents * item.quantity)}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeQueuedItem(item.id)}
                      className="text-xs text-slate-400 hover:text-rose-300"
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {!locationId && (
          <p className="text-xs text-rose-300">
            No location selected. Use the location switcher in the header first.
          </p>
        )}
        {submitMsg && <p className="text-sm text-emerald-300">{submitMsg}</p>}
        {submitErr && <p className="text-sm text-rose-300">{submitErr}</p>}
        {labelInfo && (
          <div className="flex items-center justify-between gap-2 bg-slate-950 border border-slate-700 rounded-lg p-3">
            <div className="text-xs text-slate-300">
              QR labels ready for {labelInfo.skuIds.reduce((s, r) => s + r.quantity, 0)} card
              {labelInfo.skuIds.reduce((s, r) => s + r.quantity, 0) === 1 ? '' : 's'}.
              {labelErr && <span className="block text-rose-300">{labelErr}</span>}
            </div>
            <button
              type="button"
              onClick={onPrintLabels}
              disabled={printingLabels}
              className="text-xs bg-slate-800 hover:bg-slate-700 border border-slate-600 rounded-md px-3 py-1.5"
            >
              {printingLabels ? 'Generating…' : 'Print labels'}
            </button>
          </div>
        )}
      </div>

      {/* Sticky action footer so the Add button is always reachable. */}
      <footer className="border-t border-slate-800 p-4 bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-slate-300">
            Trade total:{' '}
            <span className="font-mono font-semibold text-emerald-300">
              {formatCents(itemsTotalPayoutCents)}
            </span>
            <span className="text-slate-500">
              {' '}({queuedItems.reduce((sum, item) => sum + item.quantity, 0)} cards, {queuedItems.length} lines)
            </span>
            {queuedItems.length > 0 && (
              <span className="block text-xs text-slate-500 mt-0.5">
                + current unsaved line {formatCents(pendingLineTotalCents)} = {formatCents(projectedTradeTotalCents)} projected
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => add.mutate()}
            disabled={!locationId || add.isPending || queuedItems.length === 0}
            className="bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-700 disabled:text-slate-400 text-slate-900 font-bold rounded-lg px-5 py-2.5 transition"
          >
            {add.isPending ? 'Submitting…' : 'Submit trade batch'}
          </button>
        </div>
      </footer>
    </>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="block text-xs uppercase tracking-wide text-slate-400 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-slate-500 mt-1">{hint}</span>}
    </label>
  );
}

function Chip({ onClear, children }: { onClear: () => void; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-slate-800 border border-slate-700 text-slate-200">
      {children}
      <button
        type="button"
        onClick={onClear}
        className="text-slate-400 hover:text-rose-300 leading-none"
        aria-label="Clear filter"
      >
        ✕
      </button>
    </span>
  );
}
