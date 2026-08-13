import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  CardCondition,
  CardGradingCompany,
  CardLanguage,
  CardPrinting,
  CatalogCard,
  CatalogPriceRow,
  CatalogSetSummary,
  CreateTradeResponse,
  PayoutKind,
} from '@tcg/shared';
import {
  CARD_CONDITIONS,
  CARD_GRADING_COMPANIES,
  CARD_LANGUAGES,
  CARD_PRINTINGS,
  CATALOG_LANGUAGE_OPTIONS,
} from '@tcg/shared';
import { useSession } from '../useSession';
import { api } from '../../lib/api';
import { formatCentsAsCurrency } from '../../lib/format';
import type { TransactionMode } from '../../lib/transactions';
import { useTransactionSearchController } from './useTransactionSearchController';
import { useTradeQueueState, type TradeQueueItem } from './useTradeQueueState';
import { useTradeCardSelection } from './useTradeCardSelection';
import { GRADE_OPTIONS, suggestedGradedUnitValueCents, useTradePayoutCalculation } from './useTradePayoutCalculation';
import { useTradeGradedPrice, type TradeGradedPriceResponse } from './useTradeGradedPrice';
import { useTradeSearchQuery } from './useTradeSearchQuery';
import { openOrDownloadBlob } from '../../lib/downloadBlob';

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
      openOrDownloadBlob(blob, `qr-labels-${cardName.replace(/[^a-z0-9]+/gi, '-').slice(0, 32)}.pdf`);
    }
  }
}

async function printBillOfSale(tradeId: string): Promise<void> {
  const blob = await api.getBlob(`/tradeins/${tradeId}/bill-of-sale.pdf`);
  openOrDownloadBlob(blob, `bill-of-sale-${tradeId.slice(0, 8)}.pdf`);
}

export interface TradeModeTransactionController {
  languageOptions: ReadonlyArray<{ value: string; label: string }>;
  conditionOptions: readonly CardCondition[];
  printingOptions: readonly CardPrinting[];
  cardLanguageOptions: readonly CardLanguage[];
  rarityOptions: string[];
  query: string;
  setQuery: (value: string) => void;
  language: string;
  setLanguage: (value: string) => void;
  setId: string;
  setSetId: (value: string) => void;
  rarity: string;
  setRarity: (value: string) => void;
  selectedCard: CatalogCard | null;
  selectCard: (card: CatalogCard | null) => void;
  sets: CatalogSetSummary[];
  setsLoading: boolean;
  searchEnabled: boolean;
  searchResults: CatalogCard[];
  searchFetching: boolean;
  searchError: string | null;
  looksLikeNumber: boolean;
  inferredSetId: string | null;
  inferredSetName: string | null;
  matchedByArtist: boolean;
  artistFilter: string;
  setArtistFilter: (value: string) => void;
  resolvedArtistName: string | null;
  selectedCardPrices: CatalogPriceRow[];
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
  isGraded: boolean;
  setIsGraded: (value: boolean) => void;
  gradingCompany: CardGradingCompany;
  setGradingCompany: (value: CardGradingCompany) => void;
  gradingCompanyOptions: readonly CardGradingCompany[];
  grade: string;
  setGrade: (value: string) => void;
  gradeOptions: string[];
  certNumber: string;
  setCertNumber: (value: string) => void;
  gradedPrice: TradeGradedPriceResponse | undefined;
  gradedPriceLoading: boolean;
  gradedPriceError: boolean;
  tradeSubmitMsg: string | null;
  tradeSubmitErr: string | null;
  labelInfo: { skuIds: { skuId: string; quantity: number }[]; cardName: string } | null;
  labelErr: string | null;
  printingLabels: boolean;
  printLabels: () => Promise<void>;
  completedTradeId: string | null;
  billOfSaleErr: string | null;
  printingBillOfSale: boolean;
  printBillOfSaleForTrade: () => Promise<void>;
  addTradeItemToQueue: () => void;
  removeQueuedItem: (id: string) => void;
  submitTrade: () => void;
  selectQueuedSearchCard: (card: CatalogCard) => void;
  clearTradeSelection: () => void;
  handleLanguageChange: (value: string) => void;
}

export function useTradeTransaction(active: boolean, mode: TransactionMode): TradeModeTransactionController {
  const session = useSession();
  const qc = useQueryClient();
  const [language, setLanguage] = useState<string>('english');
  const [setId, setSetId] = useState<string>('');
  const [artistFilter, setArtistFilter] = useState<string>('');
  const [tradeSubmitMsg, setTradeSubmitMsg] = useState<string | null>(null);
  const [tradeSubmitErr, setTradeSubmitErr] = useState<string | null>(null);
  const [labelInfo, setLabelInfo] = useState<{ skuIds: { skuId: string; quantity: number }[]; cardName: string } | null>(null);
  const [labelErr, setLabelErr] = useState<string | null>(null);
  const [printingLabels, setPrintingLabels] = useState(false);
  const [completedTradeId, setCompletedTradeId] = useState<string | null>(null);
  const [billOfSaleErr, setBillOfSaleErr] = useState<string | null>(null);
  const [printingBillOfSale, setPrintingBillOfSale] = useState(false);
  const queueState = useTradeQueueState();
  const cardSelection = useTradeCardSelection(active);
  const payoutState = useTradePayoutCalculation(cardSelection.selectedCardPrices);
  const gradedPriceQuery = useTradeGradedPrice({
    cardId: cardSelection.selectedCard?.id,
    active,
    isGraded: payoutState.isGraded,
    company: payoutState.gradingCompany,
    grade: payoutState.grade,
  });

  // Once a card is marked as a graded slab, the live eBay median replaces the
  // raw ungraded TCGplayer price for both the suggested payout and the
  // market-price signal stored with the SKU.
  const effectiveMarketPriceCents = payoutState.isGraded
    ? gradedPriceQuery.data?.medianCents ?? null
    : payoutState.selectedMarketPriceCents;
  const effectiveSuggestedTradeUnitCents = payoutState.isGraded
    ? suggestedGradedUnitValueCents(gradedPriceQuery.data?.medianCents, payoutState.payout, payoutState.payoutModifier)
    : payoutState.suggestedTradeUnitCents;
  const effectivePendingLineTotalCents =
    (payoutState.overrideCents ?? effectiveSuggestedTradeUnitCents) * payoutState.quantity;

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
  const tradeSearch = useTradeSearchQuery({
    active,
    language,
    setId,
    normalizedQuery: mainSearch.normalizedQuery,
    rarityQuery: raritySearch.normalizedQuery,
    artistFilter,
  });

  useEffect(() => {
    if (!active) return;
    if (mode === 'trade') payoutState.setPayout('store_credit');
    if (mode === 'buy') payoutState.setPayout('cash');
  }, [active, mode, payoutState.setPayout]);

  const submitTradeMutation = useMutation({
    mutationFn: async () => {
      if (!session.locationId) throw new Error('Pick a location first.');
      if (!queueState.items.length) throw new Error('Add at least one line item.');
      return api.post<CreateTradeResponse>('/tradeins', {
        locationId: session.locationId,
        payout: payoutState.payout,
        items: queueState.items.map((item) => ({
          tcgapiProductId: item.tcgapiProductId,
          name: item.name,
          imageSourceUrl: item.imageSourceUrl,
          rarity: item.rarity ?? undefined,
          game: 'other' as const,
          condition: item.condition,
          printing: item.printing,
          language: item.language,
          gradingCompany: item.gradingCompany,
          grade: item.grade,
          certNumber: item.certNumber,
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
          ? `Created trade ${result.id.slice(0, 8)}... for ${formatCentsAsCurrency(result.totalValueCents)} (${cardCount} cards), pending manager approval.`
          : `Submitted ${cardCount} cards for ${formatCentsAsCurrency(result.totalValueCents)}.`,
      );
      queueState.clear();
      payoutState.setOverrideValue('');
      payoutState.setPayoutModifierPercent('0');
      payoutState.setQuantity(1);
      setBillOfSaleErr(null);
      if (result.skuIds?.length) {
        const cardName = queueState.items[0]?.name ?? cardSelection.selectedCard?.name ?? 'Card';
        setLabelInfo({ skuIds: result.skuIds, cardName });
        if (result.status !== 'pending_approval') {
          void printQrLabels(result.skuIds, cardName).catch((e) =>
            setLabelErr(e instanceof Error ? e.message : String(e)),
          );
        }
      }
      if (result.status !== 'pending_approval') {
        setCompletedTradeId(result.id);
        void printBillOfSale(result.id).catch((e) =>
          setBillOfSaleErr(e instanceof Error ? e.message : String(e)),
        );
      } else {
        setCompletedTradeId(null);
      }
      void qc.invalidateQueries({ queryKey: ['products'] });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (error: unknown) => {
      setTradeSubmitMsg(null);
      setTradeSubmitErr(error instanceof Error ? error.message : String(error));
      setLabelInfo(null);
      setCompletedTradeId(null);
      setBillOfSaleErr(null);
    },
  });

  function handleLanguageChange(next: string) {
    setLanguage(next);
    setSetId('');
  }

  function selectQueuedSearchCard(card: CatalogCard) {
    cardSelection.selectCard(card);
    payoutState.setCondition('NM');
    payoutState.setPrinting('Normal');
    payoutState.setCardLanguage('EN');
    payoutState.setQuantity(1);
    payoutState.setPayoutModifierPercent('0');
    payoutState.setOverrideValue('');
    payoutState.setIsGraded(false);
    payoutState.setGradingCompany('psa');
    payoutState.setGrade('10');
    payoutState.setCertNumber('');
    setTradeSubmitMsg(null);
    setTradeSubmitErr(null);
    setLabelInfo(null);
    setLabelErr(null);
    setCompletedTradeId(null);
    setBillOfSaleErr(null);
  }

  function addTradeItemToQueue() {
    if (!cardSelection.selectedCard) return;
    const next: TradeQueueItem = {
      id: crypto.randomUUID(),
      tcgapiProductId: cardSelection.selectedCard.id,
      name: cardSelection.selectedCard.name,
      imageSourceUrl: cardSelection.selectedCard.imageUrl,
      rarity: cardSelection.selectedCard.rarity,
      condition: payoutState.condition,
      printing: payoutState.printing,
      language: payoutState.cardLanguage,
      gradingCompany: payoutState.isGraded ? payoutState.gradingCompany : undefined,
      grade: payoutState.isGraded ? payoutState.grade : undefined,
      certNumber: payoutState.isGraded && payoutState.certNumber.trim() ? payoutState.certNumber.trim() : undefined,
      quantity: payoutState.quantity,
      payoutModifierPercent: payoutState.payoutModifier,
      overrideValueCents: payoutState.overrideCents ?? undefined,
      marketPriceCents: effectiveMarketPriceCents,
      estimatedUnitValueCents: payoutState.overrideCents ?? effectiveSuggestedTradeUnitCents,
    };

    queueState.addItem(next);
    payoutState.setQuantity(1);
    payoutState.setOverrideValue('');
    payoutState.setPayoutModifierPercent('0');
    payoutState.setCertNumber('');
    setTradeSubmitMsg(null);
    setTradeSubmitErr(null);
    setLabelErr(null);
  }

  function clearTradeSelection() {
    cardSelection.selectCard(null);
    payoutState.setIsGraded(false);
    payoutState.setGradingCompany('psa');
    payoutState.setGrade('10');
    payoutState.setCertNumber('');
    setTradeSubmitMsg(null);
    setTradeSubmitErr(null);
    setLabelInfo(null);
    setLabelErr(null);
    setCompletedTradeId(null);
    setBillOfSaleErr(null);
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

  async function printBillOfSaleForTrade() {
    if (!completedTradeId) return;
    setPrintingBillOfSale(true);
    setBillOfSaleErr(null);
    try {
      await printBillOfSale(completedTradeId);
    } catch (error) {
      setBillOfSaleErr(error instanceof Error ? error.message : String(error));
    } finally {
      setPrintingBillOfSale(false);
    }
  }

  return {
    languageOptions: CATALOG_LANGUAGE_OPTIONS,
    conditionOptions: CARD_CONDITIONS,
    printingOptions: CARD_PRINTINGS,
    cardLanguageOptions: CARD_LANGUAGES,
    rarityOptions: tradeSearch.rarityOptions,
    query: mainSearch.query,
    setQuery: mainSearch.setQuery,
    language,
    setLanguage: handleLanguageChange,
    setId,
    setSetId,
    rarity: raritySearch.query,
    setRarity: raritySearch.setQuery,
    selectedCard: cardSelection.selectedCard,
    selectCard: cardSelection.selectCard,
    sets: tradeSearch.sets,
    setsLoading: tradeSearch.setsLoading,
    searchEnabled: tradeSearch.searchEnabled,
    searchResults: tradeSearch.searchResults,
    searchFetching: tradeSearch.searchFetching,
    searchError: tradeSearch.searchError,
    looksLikeNumber: tradeSearch.isCardNumberQuery,
    inferredSetId: tradeSearch.inferredSetId,
    inferredSetName: tradeSearch.inferredSetName,
    matchedByArtist: tradeSearch.matchedByArtist,
    artistFilter,
    setArtistFilter,
    resolvedArtistName: tradeSearch.resolvedArtistName,
    selectedCardPrices: cardSelection.selectedCardPrices,
    selectedMarketPriceCents: effectiveMarketPriceCents,
    suggestedTradeUnitCents: effectiveSuggestedTradeUnitCents,
    pendingLineTotalCents: effectivePendingLineTotalCents,
    queuedTradeTotalCents: queueState.totalCents,
    queuedItems: queueState.items,
    condition: payoutState.condition,
    setCondition: payoutState.setCondition,
    printing: payoutState.printing,
    setPrinting: payoutState.setPrinting,
    cardLanguage: payoutState.cardLanguage,
    setCardLanguage: payoutState.setCardLanguage,
    quantity: payoutState.quantity,
    setQuantity: payoutState.setQuantity,
    payout: payoutState.payout,
    setPayout: payoutState.setPayout,
    payoutModifierPercent: payoutState.payoutModifierPercent,
    setPayoutModifierPercent: payoutState.setPayoutModifierPercent,
    overrideValue: payoutState.overrideValue,
    setOverrideValue: payoutState.setOverrideValue,
    isGraded: payoutState.isGraded,
    setIsGraded: payoutState.setIsGraded,
    gradingCompany: payoutState.gradingCompany,
    setGradingCompany: payoutState.setGradingCompany,
    gradingCompanyOptions: CARD_GRADING_COMPANIES,
    grade: payoutState.grade,
    setGrade: payoutState.setGrade,
    gradeOptions: GRADE_OPTIONS[payoutState.gradingCompany],
    certNumber: payoutState.certNumber,
    setCertNumber: payoutState.setCertNumber,
    gradedPrice: gradedPriceQuery.data,
    gradedPriceLoading: gradedPriceQuery.isLoading,
    gradedPriceError: gradedPriceQuery.isError,
    tradeSubmitMsg,
    tradeSubmitErr,
    labelInfo,
    labelErr,
    printingLabels,
    printLabels,
    completedTradeId,
    billOfSaleErr,
    printingBillOfSale,
    printBillOfSaleForTrade,
    addTradeItemToQueue,
    removeQueuedItem: queueState.removeItem,
    submitTrade,
    selectQueuedSearchCard,
    clearTradeSelection,
    handleLanguageChange,
  };
}
