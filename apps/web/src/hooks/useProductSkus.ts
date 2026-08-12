import { useQuery } from '@tanstack/react-query';
import type { ProductSkusResponse } from '@tcg/shared';
import { api } from '../lib/api';
import { queryKeys } from '../lib/queryKeys';

export function useProductSkus<TResponse = ProductSkusResponse>(
  productId: string | null | undefined,
  options: { enabled?: boolean; scope?: string } = {},
) {
  const enabled = options.enabled ?? !!productId;
  return useQuery<TResponse>({
    queryKey: queryKeys.products.skus(productId, options.scope),
    queryFn: ({ signal }) => api.get<TResponse>(`/products/${productId!}/skus`, { signal }),
    enabled: enabled && !!productId,
    staleTime: 30_000,
  });
}
