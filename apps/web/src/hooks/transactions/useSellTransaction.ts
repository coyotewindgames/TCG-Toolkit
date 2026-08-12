import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useQuery } from '@tanstack/react-query';
import { useBarcodeScanner } from '../useBarcodeScanner';
import { useSession } from '../useSession';
import type {
  OrderDetailResponse,
  OrderLineView,
  OrderTotals,
  ProductSearchItem,
  ProductSearchResponse,
  ProductSkusResponse,
} from '@tcg/shared';
import { api } from '../../lib/api';
import { toBase64UrlJson } from '../../lib/encoding';
import { queryKeys } from '../../lib/queryKeys';
import { getSocket } from '../../lib/socket';
import { useTransactionSearchController } from './useTransactionSearchController';

export interface SellModeTransactionController {
  remoteScanQr: string | null;
  remoteScanUrl: string | null;
  sellQuery: string;
  setSellQuery: (value: string) => void;
  searchingCards: boolean;
  cardSearchError: string | null;
  cardResults: ProductSearchItem[];
  selectedProduct: ProductSearchItem | null;
  selectProduct: (product: ProductSearchItem | null) => void;
  selectedProductSkus: ProductSkusResponse['skus'];
  loadingProductSkus: boolean;
  productSkuError: string | null;
  addingSkuId: string | null;
  lines: OrderLineView[];
  totals: OrderTotals;
  sellStatus: 'idle' | 'scanning' | 'checkout' | 'paid';
  sellError: string | null;
  checkoutSell: () => Promise<void>;
  cancelSell: () => Promise<void>;
  addSellSku: (barcode: string, skuId: string) => Promise<void>;
}

function isLocalOrigin(origin: string) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin);
}

export function useSellTransaction(active: boolean): SellModeTransactionController {
  const session = useSession();
  const [orderId, setOrderId] = useState<string | null>(null);
  const [lines, setLines] = useState<OrderLineView[]>([]);
  const [totals, setTotals] = useState<OrderTotals>({
    subtotalCents: 0,
    taxCents: 0,
    totalCents: 0,
  });
  const [sellStatus, setSellStatus] = useState<'idle' | 'scanning' | 'checkout' | 'paid'>('idle');
  const [sellError, setSellError] = useState<string | null>(null);
  const sellSearchController = useTransactionSearchController({
    debounceMs: 300,
    minQueryLength: 2,
  });
  const [selectedProduct, setSelectedProduct] = useState<ProductSearchItem | null>(null);
  const [addingSkuId, setAddingSkuId] = useState<string | null>(null);
  const [remoteScanQr, setRemoteScanQr] = useState<string | null>(null);

  const configuredRemoteBase = import.meta.env.VITE_REMOTE_SCAN_BASE_URL?.trim();
  const browserOrigin = typeof window !== 'undefined' ? window.location.origin : null;
  const remoteScanBase = configuredRemoteBase
    ? configuredRemoteBase.replace(/\/+$/, '')
    : browserOrigin && !isLocalOrigin(browserOrigin)
      ? browserOrigin
      : null;

  const remoteScanUrl =
    orderId && remoteScanBase && session.user && session.accessToken
      ? `${remoteScanBase}/remote-scan?orderId=${encodeURIComponent(orderId)}#h=${encodeURIComponent(
          toBase64UrlJson({
            accessToken: session.accessToken,
            user: session.user,
            locationId: session.locationId,
            registerId: session.registerId,
          }),
        )}`
      : null;

  const createOrder = useCallback(async () => {
    if (!session.locationId) return null;
    const created = await api.post<{ id: string }>('/orders', {
      locationId: session.locationId,
      ...(session.registerId ? { registerId: session.registerId } : {}),
    });
    setOrderId(created.id);
    return created.id;
  }, [session.locationId, session.registerId]);

  const refreshOrder = useCallback(async () => {
    if (!orderId) return;
    const data = await api.get<OrderDetailResponse>(`/orders/${orderId}`);
    setTotals({
      subtotalCents: data.order.subtotalCents,
      taxCents: data.order.taxCents,
      totalCents: data.order.totalCents,
    });
    setLines(
      data.items.map((item) => ({
        id: item.id,
        skuId: item.skuId,
        name: item.productNameSnapshot ?? 'Scanned item',
        condition: item.condition,
        unitPriceCents: item.unitPriceCents,
        qty: item.quantity,
        imageUrl: item.imageUrl ?? undefined,
        qtyRemaining: item.qtyRemaining,
      })),
    );
  }, [orderId]);

  useEffect(() => {
    if (!active || !session.locationId || orderId) return;
    void createOrder().catch((e: unknown) => {
      setSellError(e instanceof Error ? e.message : String(e));
    });
  }, [active, session.locationId, orderId, createOrder]);

  useEffect(() => {
    if (!active || !remoteScanUrl) {
      setRemoteScanQr(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(remoteScanUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
    })
      .then((url) => {
        if (!cancelled) setRemoteScanQr(url);
      })
      .catch(() => {
        if (!cancelled) setRemoteScanQr(null);
      });
    return () => {
      cancelled = true;
    };
  }, [active, remoteScanUrl]);

  useEffect(() => {
    if (!active || !orderId) return;
    const socket = getSocket();
    socket.emit('order.join', { orderId });
    const onItem = (msg: { orderId: string }) => {
      if (msg.orderId !== orderId) return;
      void refreshOrder();
    };
    const onRemoved = (msg: { orderId: string }) => {
      if (msg.orderId !== orderId) return;
      void refreshOrder();
    };
    const onCompleted = () => setSellStatus('paid');
    socket.on('cart.itemAdded', onItem);
    socket.on('cart.itemRemoved', onRemoved);
    socket.on('order.completed', onCompleted);
    return () => {
      socket.off('cart.itemAdded', onItem);
      socket.off('cart.itemRemoved', onRemoved);
      socket.off('order.completed', onCompleted);
    };
  }, [active, orderId, refreshOrder]);

  useEffect(() => {
    if (!active || !orderId) return;
    void refreshOrder().catch(() => undefined);
    const timer = window.setInterval(() => {
      void refreshOrder().catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [active, orderId, refreshOrder]);

  const sellSearch = useQuery<ProductSearchResponse>({
    queryKey: queryKeys.sell.search(sellSearchController.normalizedQuery),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({
        q: sellSearchController.normalizedQuery,
        page: '1',
        pageSize: '8',
        sort: 'name_asc',
      });
      return api.get<ProductSearchResponse>(`/products/search?${params.toString()}`, { signal });
    },
    enabled: active && sellSearchController.isSearchEnabled,
    staleTime: 30_000,
  });

  const selectedProductSkus = useQuery<ProductSkusResponse>({
    queryKey: queryKeys.sell.skus(selectedProduct?.id),
    queryFn: ({ signal }) => api.get<ProductSkusResponse>(`/products/${selectedProduct!.id}/skus`, { signal }),
    enabled: active && !!selectedProduct?.id,
    staleTime: 30_000,
  });

  useBarcodeScanner(async (barcode) => {
    if (!active || !orderId || sellStatus === 'paid') return;
    setSellStatus('scanning');
    try {
      await api.post(`/orders/${orderId}/items`, { barcode });
      await refreshOrder();
      setSellError(null);
    } catch (e) {
      setSellError(e instanceof Error ? e.message : String(e));
    } finally {
      setSellStatus('idle');
    }
  });

  async function checkoutSell() {
    if (!orderId) return;
    setSellStatus('checkout');
    try {
      await api.post(`/orders/${orderId}/record-sale`, {});
      setSellStatus('paid');
      setSellError(null);
    } catch (e) {
      setSellError(e instanceof Error ? e.message : String(e));
      setSellStatus('idle');
    }
  }

  async function cancelSell() {
    if (!orderId || sellStatus === 'paid') return;
    setSellStatus('checkout');
    try {
      await api.post(`/orders/${orderId}/cancel`, {});
      setSellError(null);
      setLines([]);
      setTotals({ subtotalCents: 0, taxCents: 0, totalCents: 0 });
      sellSearchController.setQuery('');
      setSelectedProduct(null);
      setOrderId(null);
      await createOrder();
    } catch (e) {
      setSellError(e instanceof Error ? e.message : String(e));
    } finally {
      setSellStatus('idle');
    }
  }

  async function addSellSku(barcode: string, skuId: string) {
    if (!orderId || sellStatus === 'paid') return;
    setAddingSkuId(skuId);
    try {
      await api.post(`/orders/${orderId}/items`, { barcode });
      await refreshOrder();
      setSellError(null);
    } catch (e) {
      setSellError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddingSkuId(null);
    }
  }

  return {
    remoteScanQr,
    remoteScanUrl,
    sellQuery: sellSearchController.query,
    setSellQuery: sellSearchController.setQuery,
    searchingCards: sellSearch.isFetching,
    cardSearchError: sellSearch.error ? (sellSearch.error as Error).message : null,
    cardResults: sellSearch.data?.results ?? [],
    selectedProduct,
    selectProduct: setSelectedProduct,
    selectedProductSkus: selectedProductSkus.data?.skus ?? [],
    loadingProductSkus: selectedProductSkus.isLoading,
    productSkuError: selectedProductSkus.error ? (selectedProductSkus.error as Error).message : null,
    addingSkuId,
    lines,
    totals,
    sellStatus,
    sellError,
    checkoutSell,
    cancelSell,
    addSellSku,
  };
}
