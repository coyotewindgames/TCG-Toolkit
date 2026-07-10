import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CardCondition, CardLanguage, CardPrinting, PayoutKind } from '@tcg/shared';
import { useSession } from '../useSession';
import { api } from '../../lib/api';
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

  // Infer a set from the free-text query. Example: typing
  // "rayquaza evolving skies" splits into name="rayquaza" + setId=(Evolving Skies).
  // The user's explicit set filter always wins.
  const inferredSet = useMemo(() => {
    if (setId) return null;
    if (looksLikeNumber) return null;
    const sets = setsQuery.data?.sets ?? [];
    if (!sets.length || !nameParam) return null;
    const haystack = nameParam.toLowerCase();
    let best: { id: string; name: string; start: number; length: number } | null = null;
    for (const set of sets) {
      const needle = set.name.toLowerCase();
      if (needle.length < 3) continue;
      const idx = haystack.indexOf(needle);
      if (idx === -1) continue;
      if (!best || needle.length > best.length) {
        best = { id: set.id, name: set.name, start: idx, length: needle.length };
      }
    }
    return best;
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
    active && (effectiveNameParam.length >= 2 || (!!numberParam && !!effectiveSetId) || !!effectiveSetId);

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

  const searchResults = useMemo(() => {
    const all = searchQuery.data?.results ?? [];
    if (!raritySearch.normalizedQuery) return all;
    const needle = raritySearch.normalizedQuery.toLowerCase();
    return all.filter((card) => card.rarity?.toLowerCase().includes(needle));
  }, [searchQuery.data, raritySearch.normalizedQuery]);

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
    searchFetching: searchQuery.isFetching,
    searchError: searchQuery.error ? (searchQuery.error as Error).message : null,
    looksLikeNumber,
    inferredSetId: inferredSet?.id ?? null,
    inferredSetName: inferredSet?.name ?? null,
    matchedByArtist: searchQuery.data?.matchedBy === 'artist',
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
