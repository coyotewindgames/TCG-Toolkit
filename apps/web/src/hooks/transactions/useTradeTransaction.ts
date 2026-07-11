import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CardCondition, CardLanguage, CardPrinting, PayoutKind } from '@tcg/shared';
import { useSession } from '../useSession';
import { api } from '../../lib/api';
import { detectSet, normalizeSet } from '../../lib/pokemonSets';
import type { TransactionMode } from '../../lib/transactions';
import { useTransactionSearchController } from './useTransactionSearchController';
import { useTradeQueueState, type TradeQueueItem } from './useTradeQueueState';

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
  artist?: string | null;
};

type SearchResponse = {
  results: TcgapiCard[];
  page: number;
  perPage: number;
  hasMore: boolean;
  total: number | null;
  matchedBy?: 'name' | 'artist';
};

type ArtistSearchResponse = {
  results: TcgapiCard[];
  page: number;
  perPage: number;
  hasMore: boolean;
  total: number;
  resolvedArtist: { slug: string; displayName: string; method: string } | null;
};

/**
 * Heuristic: does this free-text query look like a person's name? Used to
 * trigger a transparent secondary artist search when the main pkmnprices
 * name-search returns nothing (e.g. operator types "yuka morii" into the
 * general search box instead of the dedicated artist field).
 *
 * Matches two-to-four space-separated tokens starting with a letter and made
 * of letters, apostrophes, hyphens, or dots. Deliberately conservative so we
 * don't fire artist searches for things like "charizard vmax" or "moltres ex".
 */
function looksLikePersonName(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 60) return false;
  if (/\d/.test(trimmed)) return false;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 2 || tokens.length > 4) return false;
  return tokens.every((t) => /^[A-Za-z][A-Za-z'.-]{1,20}$/.test(t));
}

type SetRow = { id: string; name: string; slug?: string };
type SetsResponse = { sets: SetRow[] };

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

const LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'english', label: 'English' },
  { value: 'japanese', label: 'Japanese (Pro tier)' },
];

const CONDITIONS: CardCondition[] = ['NM', 'LP', 'MP', 'HP', 'DMG'];
const PRINTINGS: CardPrinting[] = ['Normal', 'Foil', 'Reverse', 'Holo', 'FirstEdition'];
const CARD_LANGUAGES: CardLanguage[] = ['EN', 'JP', 'DE', 'FR', 'IT', 'ES', 'PT', 'KO', 'CN'];
const NUMBER_QUERY_RE = /^(?=.*\d)[a-z0-9#\-\s]+(\s*\/\s*[a-z0-9#\-\s]+)?$/i;
const PAYOUT_MULTIPLIERS: Record<PayoutKind, number> = {
  cash: 0.7,
  store_credit: 0.8,
};

function pickPricingRow(prices: PriceRow[] | undefined, printing: CardPrinting): PriceRow | undefined {
  if (!prices?.length) return undefined;
  return (
    prices.find((row) => tcgapiPrintingToEnum(row.printing) === printing) ??
    prices.find((row) => (row.marketCents ?? 0) > 0) ??
    prices[0]
  );
}

function tcgapiPrintingToEnum(label: string): CardPrinting {
  const normalized = label.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!normalized) return 'Normal';
  if (normalized.includes('reverseholo') || normalized === 'reverse' || normalized === 'rh') return 'Reverse';
  if (normalized.includes('1stedition') || normalized.includes('firstedition')) return 'FirstEdition';
  if (normalized.includes('holo')) return 'Holo';
  if (normalized.includes('foil') && !normalized.includes('non')) return 'Foil';
  return 'Normal';
}

function suggestedUnitValueCents(
  prices: PriceRow[] | undefined,
  printing: CardPrinting,
  payout: PayoutKind,
  payoutModifierPercent: number,
): number {
  const row = pickPricingRow(prices, printing);
  if (!row) return 0;
  const candidates = [row.marketCents, row.medianCents].filter(
    (value): value is number => typeof value === 'number' && value > 0,
  );
  const base = candidates.length ? Math.min(...candidates) : 0;
  const payoutBase = Math.max(0, Math.floor(base * PAYOUT_MULTIPLIERS[payout]));
  return Math.max(0, Math.floor(payoutBase * (1 + payoutModifierPercent / 100)));
}

function formatCents(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Break a string into significant tokens for set-name matching. We drop
 * tokens shorter than 3 characters (roman numerals, joiners like "of"/"to"
 * that would over-match) so that partial queries like "evolving skies"
 * still line up cleanly with set names that carry decorations.
 */
function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

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
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `qr-labels-${cardName.replace(/[^a-z0-9]+/gi, '-').slice(0, 32)}.pdf`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }
}

export interface TradeModeTransactionController {
  languageOptions: Array<{ value: string; label: string }>;
  conditionOptions: CardCondition[];
  printingOptions: CardPrinting[];
  cardLanguageOptions: CardLanguage[];
  rarityOptions: string[];
  query: string;
  setQuery: (value: string) => void;
  language: string;
  setLanguage: (value: string) => void;
  setId: string;
  setSetId: (value: string) => void;
  rarity: string;
  setRarity: (value: string) => void;
  selectedCard: TcgapiCard | null;
  selectCard: (card: TcgapiCard | null) => void;
  sets: SetRow[];
  setsLoading: boolean;
  searchEnabled: boolean;
  searchResults: TcgapiCard[];
  searchFetching: boolean;
  searchError: string | null;
  looksLikeNumber: boolean;
  inferredSetId: string | null;
  inferredSetName: string | null;
  matchedByArtist: boolean;
  /** Free-text artist filter (dedicated input in the Trade/Buy filter row). */
  artistFilter: string;
  setArtistFilter: (value: string) => void;
  /**
   * Canonical artist name resolved by the pkmncards artist-search endpoint
   * (either from `artistFilter` or from the auto-fallback trigger). Shown as
   * a chip so operators can see how their query was interpreted.
   */
  resolvedArtistName: string | null;
  selectedCardPrices: PriceRow[];
  selectedMarketPriceCents: number | null;
  suggestedTradeUnitCents: number;
  pendingLineTotalCents: number;
  queuedTradeTotalCents: number;
  queuedItems: TradeQueueItem[];
  condition: CardCondition;
  setCondition: (value: CardCondition) => void;
  printing: CardPrinting;
  setPrinting: (value: CardPrinting) => void;
  cardLanguage: CardLanguage;
  setCardLanguage: (value: CardLanguage) => void;
  quantity: number;
  setQuantity: (value: number) => void;
  payout: PayoutKind;
  setPayout: (value: PayoutKind) => void;
  payoutModifierPercent: string;
  setPayoutModifierPercent: (value: string) => void;
  overrideValue: string;
  setOverrideValue: (value: string) => void;
  tradeSubmitMsg: string | null;
  tradeSubmitErr: string | null;
  labelInfo: { skuIds: { skuId: string; quantity: number }[]; cardName: string } | null;
  labelErr: string | null;
  printingLabels: boolean;
  printLabels: () => Promise<void>;
  addTradeItemToQueue: () => void;
  removeQueuedItem: (id: string) => void;
  submitTrade: () => void;
  selectQueuedSearchCard: (card: TcgapiCard) => void;
  clearTradeSelection: () => void;
  handleLanguageChange: (value: string) => void;
}

export function useTradeTransaction(active: boolean, mode: TransactionMode): TradeModeTransactionController {
  const session = useSession();
  const qc = useQueryClient();
  const [language, setLanguage] = useState<string>('english');
  const [setId, setSetId] = useState<string>('');
  const [selectedCard, setSelectedCard] = useState<TcgapiCard | null>(null);
  const queueState = useTradeQueueState();
  const [condition, setCondition] = useState<CardCondition>('NM');
  const [printing, setPrinting] = useState<CardPrinting>('Normal');
  const [cardLanguage, setCardLanguage] = useState<CardLanguage>('EN');
  const [quantity, setQuantity] = useState<number>(1);
  const [payout, setPayout] = useState<PayoutKind>('cash');
  const [payoutModifierPercent, setPayoutModifierPercent] = useState<string>('0');
  const [overrideValue, setOverrideValue] = useState<string>('');
  const [tradeSubmitMsg, setTradeSubmitMsg] = useState<string | null>(null);
  const [tradeSubmitErr, setTradeSubmitErr] = useState<string | null>(null);
  const [labelInfo, setLabelInfo] = useState<{ skuIds: { skuId: string; quantity: number }[]; cardName: string } | null>(null);
  const [labelErr, setLabelErr] = useState<string | null>(null);
  const [printingLabels, setPrintingLabels] = useState(false);
  /**
   * Dedicated artist filter. When set, the search results come from
   * `/pkmncards/artist-search` instead of pkmnprices — pkmnprices' upstream
   * `/v1/cards` endpoint has no artist parameter, so this is the only way to
   * reliably surface e.g. every card illustrated by "kagemaru himeno".
   */
  const [artistFilter, setArtistFilter] = useState<string>('');

  const mainSearch = useTransactionSearchController({
    initialQuery: '',
    debounceMs: 300,
    minQueryLength: 2,
  });
  const raritySearch = useTransactionSearchController({
    initialQuery: '',
    debounceMs: 300,
    minQueryLength: 0,
    allowEmpty: true,
  });

  useEffect(() => {
    if (!active) return;
    if (mode === 'trade') setPayout('store_credit');
    if (mode === 'buy') setPayout('cash');
  }, [active, mode]);

  const looksLikeNumber = NUMBER_QUERY_RE.test(mainSearch.normalizedQuery);
  const numberParam = looksLikeNumber ? mainSearch.normalizedQuery : '';
  const nameParam = looksLikeNumber ? '' : mainSearch.normalizedQuery;

  const setsQuery = useQuery<SetsResponse>({
    // Cache key bumped to v2 after the API started returning the full set list
    // (previously capped at 50 rows). Bumping the key forces a refetch so
    // operators don't need to clear browser storage to pick up the new data.
    queryKey: ['transactions.trade.sets.v2', language],
    queryFn: () => api.get<SetsResponse>(`/pkmnprices/sets?language=${encodeURIComponent(language)}`),
    enabled: active,
    staleTime: 24 * 60 * 60_000,
  });

  // Infer a set from the free-text query. We try two sources of truth in
  // priority order and pick the more confident hit:
  //   1. The canonical Pokémon set bundle (`lib/pokemonSets`) — recognizes
  //      shorthand codes (`PRE`, `SVI`) and common typos (`sword and shield`)
  //      that pkmnprices' catalog doesn't cover verbatim.
  //   2. Every significant token of a pkmnprices set name appears in the
  //      query — catches sets that pkmnprices names differently than the
  //      canonical bundle (e.g. localized suffixes) and picks up brand-new
  //      sets before we've added them to the canonical list.
  // The operator's explicit set filter always wins over inference.
  const inferredSet = useMemo(() => {
    if (setId) return null;
    if (looksLikeNumber) return null;
    if (!nameParam) return null;
    const sets = setsQuery.data?.sets ?? [];

    // Strategy 1: canonical bundle.
    const canonical = detectSet(nameParam);
    if (canonical) {
      // Look up the id from pkmnprices' set list. Normalize both sides so
      // "Pokémon GO" and "Pokemon GO" match without a bespoke unicode dance.
      const target = normalizeSet(canonical.name);
      const pricedMatch = sets.find((s) => normalizeSet(s.name) === target);
      // Fall back to id='' if the canonical hit isn't in pkmnprices yet — the
      // UI still gets to strip the set substring from the outgoing query.
      return {
        id: pricedMatch?.id ?? '',
        name: canonical.name,
        start: canonical.start,
        length: canonical.length,
      };
    }

    // Strategy 2: token match against the pkmnprices set list directly.
    if (!sets.length) return null;
    const haystack = nameParam.toLowerCase();
    const queryTokens = new Set(tokenize(haystack));
    if (!queryTokens.size) return null;

    let bestTokenMatch: { id: string; name: string; start: number; length: number; score: number } | null = null;
    for (const set of sets) {
      const needle = set.name.toLowerCase();
      if (needle.length < 3) continue;
      const setTokens = tokenize(needle);
      if (setTokens.length < 1) continue;
      const allMatch = setTokens.every((token) => queryTokens.has(token));
      if (!allMatch) continue;
      const score = setTokens.reduce((sum, token) => sum + token.length, 0);
      const firstToken = setTokens[0];
      const lastToken = setTokens[setTokens.length - 1];
      const start = haystack.indexOf(firstToken);
      const endIdx = haystack.lastIndexOf(lastToken);
      const length = endIdx >= 0 ? endIdx + lastToken.length - start : firstToken.length;

      if (!bestTokenMatch || score > bestTokenMatch.score) {
        bestTokenMatch = {
          id: set.id,
          name: set.name,
          start: Math.max(0, start),
          length: Math.max(firstToken.length, length),
          score,
        };
      }
    }
    return bestTokenMatch;
  }, [setId, looksLikeNumber, setsQuery.data, nameParam]);

  const nameParamAfterSetStrip = useMemo(() => {
    if (!inferredSet) return nameParam;
    return (
      nameParam.slice(0, inferredSet.start) +
      nameParam.slice(inferredSet.start + inferredSet.length)
    )
      .replace(/\s+/g, ' ')
      .trim();
  }, [inferredSet, nameParam]);

  const effectiveNameParam = inferredSet ? nameParamAfterSetStrip : nameParam;
  const effectiveSetId = setId || inferredSet?.id || '';

  const searchEnabled =
    active &&
    !artistFilter &&
    (effectiveNameParam.length >= 2 || (!!numberParam && !!effectiveSetId) || !!effectiveSetId);

  const searchQuery = useQuery<SearchResponse>({
    queryKey: [
      'transactions.trade.search',
      {
        nameParam: effectiveNameParam,
        numberParam,
        language,
        setId: effectiveSetId,
        debouncedRarity: raritySearch.normalizedQuery,
      },
    ],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams();
      if (effectiveNameParam) params.set('q', effectiveNameParam);
      if (numberParam) params.set('number', numberParam);
      // pkmnprices treats missing language as "any"; English is the implicit
      // default and the upstream API returns zero results when we pin it
      // explicitly, so only send the param for non-default languages.
      if (language && language !== 'english') params.set('language', language);
      if (effectiveSetId) params.set('setId', effectiveSetId);
      params.set('perPage', '24');
      return api.get<SearchResponse>(`/pkmnprices/search?${params.toString()}`, { signal });
    },
    enabled: searchEnabled,
    staleTime: 60_000,
  });

  // Artist search — two triggers:
  //   1. Dedicated `artistFilter` input (explicit intent). Runs even when
  //      the main name search is disabled.
  //   2. Auto-fallback: main search settled with zero results AND the free
  //      text looks like a person's name AND no manual artist. Handles the
  //      common case of an operator typing "yuka morii" in the main box.
  const shouldAutoFallbackArtist =
    !artistFilter &&
    searchEnabled &&
    !searchQuery.isFetching &&
    (searchQuery.data?.results.length ?? 0) === 0 &&
    looksLikePersonName(effectiveNameParam);
  const artistSearchTerm = artistFilter.trim() || (shouldAutoFallbackArtist ? effectiveNameParam : '');

  const artistSearchQuery = useQuery<ArtistSearchResponse>({
    queryKey: ['transactions.trade.artistSearch', artistSearchTerm],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams();
      params.set('name', artistSearchTerm);
      params.set('perPage', '24');
      return api.get<ArtistSearchResponse>(`/pkmncards/artist-search?${params.toString()}`, { signal });
    },
    enabled: active && artistSearchTerm.length >= 2,
    staleTime: 5 * 60_000,
  });

  const searchResults = useMemo(() => {
    // When the operator typed an explicit artist filter, artist results are
    // the source of truth. When the auto-fallback triggered we merge: main
    // (empty) results ++ artist results so the UI stays consistent even if
    // the main query recovers between renders.
    const primary = searchQuery.data?.results ?? [];
    const artist = artistSearchQuery.data?.results ?? [];
    const combined = artistFilter
      ? artist
      : primary.length > 0
        ? primary
        : artist;
    // Drop cards without a hydrated pkmnprices id — the queue add path needs
    // it for the /prices lookup. Degraded (id === '') hits from the artist
    // endpoint would otherwise blow up on selection.
    const usable = combined.filter((card) => card.id);
    if (!raritySearch.normalizedQuery) return usable;
    const needle = raritySearch.normalizedQuery.toLowerCase();
    return usable.filter((card) => card.rarity?.toLowerCase().includes(needle));
  }, [
    searchQuery.data,
    artistSearchQuery.data,
    artistFilter,
    raritySearch.normalizedQuery,
  ]);

  const rarityOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const card of searchQuery.data?.results ?? []) {
      if (card.rarity) seen.add(card.rarity);
    }
    return Array.from(seen).sort();
  }, [searchQuery.data]);

  const selectedCardPricesQuery = useQuery<PricesResponse>({
    queryKey: ['transactions.trade.prices', selectedCard?.id],
    queryFn: ({ signal }) =>
      api.get<PricesResponse>(`/pkmnprices/cards/${encodeURIComponent(selectedCard!.id)}/prices`, { signal }),
    enabled: active && !!selectedCard?.id,
    staleTime: 5 * 60_000,
  });

  const payoutModifier = useMemo(() => {
    const value = Number(payoutModifierPercent);
    return Number.isFinite(value) ? value : 0;
  }, [payoutModifierPercent]);

  const overrideCents = useMemo(() => {
    const value = overrideValue.trim();
    if (!value) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return Math.round(parsed * 100);
  }, [overrideValue]);

  const suggestedTradeUnitCents = useMemo(
    () => suggestedUnitValueCents(selectedCardPricesQuery.data?.prices, printing, payout, payoutModifier),
    [selectedCardPricesQuery.data?.prices, printing, payout, payoutModifier],
  );

  const selectedMarketPriceCents = useMemo(() => {
    const row = pickPricingRow(selectedCardPricesQuery.data?.prices, printing);
    return row?.marketCents ?? null;
  }, [selectedCardPricesQuery.data?.prices, printing]);

  const pendingLineTotalCents = (overrideCents ?? suggestedTradeUnitCents) * quantity;
  const queuedTradeTotalCents = queueState.totalCents;

  const selectedCardPrices = selectedCardPricesQuery.data?.prices ?? [];

  const submitTradeMutation = useMutation({
    mutationFn: async () => {
      if (!session.locationId) throw new Error('Pick a location first.');
      if (!queueState.items.length) throw new Error('Add at least one line item.');
      return api.post<CreateTradeResponse>('/tradeins', {
        locationId: session.locationId,
        payout,
        items: queueState.items.map((item) => ({
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
      });
    },
    onSuccess: (result) => {
      const cardCount = queueState.cardCount;
      setTradeSubmitErr(null);
      setTradeSubmitMsg(
        result.status === 'pending_approval'
          ? `Created trade ${result.id.slice(0, 8)}... for ${formatCents(result.totalValueCents)} (${cardCount} cards), pending manager approval.`
          : `Submitted ${cardCount} cards for ${formatCents(result.totalValueCents)}.`,
      );
      queueState.clear();
      setOverrideValue('');
      setPayoutModifierPercent('0');
      setQuantity(1);
      if (result.skuIds?.length) {
        const cardName = queueState.items[0]?.name ?? selectedCard?.name ?? 'Card';
        setLabelInfo({ skuIds: result.skuIds, cardName });
        if (result.status !== 'pending_approval') {
          void printQrLabels(result.skuIds, cardName).catch((e) =>
            setLabelErr(e instanceof Error ? e.message : String(e)),
          );
        }
      }
      void qc.invalidateQueries({ queryKey: ['products'] });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (error: unknown) => {
      setTradeSubmitMsg(null);
      setTradeSubmitErr(error instanceof Error ? error.message : String(error));
      setLabelInfo(null);
    },
  });

  function handleLanguageChange(next: string) {
    setLanguage(next);
    setSetId('');
  }

  function selectQueuedSearchCard(card: TcgapiCard) {
    setSelectedCard(card);
    setCondition('NM');
    setPrinting('Normal');
    setCardLanguage('EN');
    setQuantity(1);
    setPayoutModifierPercent('0');
    setOverrideValue('');
    setTradeSubmitMsg(null);
    setTradeSubmitErr(null);
    setLabelInfo(null);
    setLabelErr(null);
  }

  function addTradeItemToQueue() {
    if (!selectedCard) return;
    const next: TradeQueueItem = {
      id: crypto.randomUUID(),
      tcgapiProductId: selectedCard.id,
      name: selectedCard.name,
      imageSourceUrl: selectedCard.imageUrl,
      rarity: selectedCard.rarity,
      condition,
      printing,
      language: cardLanguage,
      quantity,
      payoutModifierPercent: payoutModifier,
      overrideValueCents: overrideCents ?? undefined,
      marketPriceCents: selectedMarketPriceCents,
      estimatedUnitValueCents: overrideCents ?? suggestedTradeUnitCents,
    };

    queueState.addItem(next);

    setQuantity(1);
    setOverrideValue('');
    setPayoutModifierPercent('0');
    setTradeSubmitMsg(null);
    setTradeSubmitErr(null);
    setLabelErr(null);
  }

  function removeQueuedItem(id: string) {
    queueState.removeItem(id);
  }

  function clearTradeSelection() {
    setSelectedCard(null);
    setTradeSubmitMsg(null);
    setTradeSubmitErr(null);
    setLabelInfo(null);
    setLabelErr(null);
  }

  async function submitTrade() {
    await submitTradeMutation.mutateAsync();
  }

  async function printLabels() {
    if (!labelInfo) return;
    setPrintingLabels(true);
    setLabelErr(null);
    try {
      await printQrLabels(labelInfo.skuIds, labelInfo.cardName);
    } catch (error) {
      setLabelErr(error instanceof Error ? error.message : String(error));
    } finally {
      setPrintingLabels(false);
    }
  }

  return {
    languageOptions: LANGUAGE_OPTIONS,
    conditionOptions: CONDITIONS,
    printingOptions: PRINTINGS,
    cardLanguageOptions: CARD_LANGUAGES,
    rarityOptions,
    query: mainSearch.query,
    setQuery: mainSearch.setQuery,
    language,
    setLanguage: handleLanguageChange,
    setId,
    setSetId,
    rarity: raritySearch.query,
    setRarity: raritySearch.setQuery,
    selectedCard,
    selectCard: setSelectedCard,
    sets: setsQuery.data?.sets ?? [],
    setsLoading: setsQuery.isLoading,
    searchEnabled,
    searchResults,
    searchFetching: searchQuery.isFetching || artistSearchQuery.isFetching,
    searchError:
      (searchQuery.error ? (searchQuery.error as Error).message : null) ??
      (artistSearchQuery.error ? (artistSearchQuery.error as Error).message : null),
    looksLikeNumber,
    inferredSetId: inferredSet?.id ?? null,
    inferredSetName: inferredSet?.name ?? null,
    matchedByArtist:
      !!artistFilter ||
      (artistSearchQuery.data?.resolvedArtist != null &&
        (artistSearchQuery.data?.results.length ?? 0) > 0 &&
        (searchQuery.data?.results.length ?? 0) === 0),
    artistFilter,
    setArtistFilter,
    resolvedArtistName: artistSearchQuery.data?.resolvedArtist?.displayName ?? null,
    selectedCardPrices,
    selectedMarketPriceCents,
    suggestedTradeUnitCents,
    pendingLineTotalCents,
    queuedTradeTotalCents,
    queuedItems: queueState.items,
    condition,
    setCondition,
    printing,
    setPrinting,
    cardLanguage,
    setCardLanguage,
    quantity,
    setQuantity,
    payout,
    setPayout,
    payoutModifierPercent,
    setPayoutModifierPercent,
    overrideValue,
    setOverrideValue,
    tradeSubmitMsg,
    tradeSubmitErr,
    labelInfo,
    labelErr,
    printingLabels,
    printLabels,
    addTradeItemToQueue,
    removeQueuedItem,
    submitTrade,
    selectQueuedSearchCard,
    clearTradeSelection,
    handleLanguageChange,
  };
}
