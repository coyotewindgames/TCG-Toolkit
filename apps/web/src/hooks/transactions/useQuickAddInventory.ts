import { useMutation } from '@tanstack/react-query';
import type { QuickAddInventoryRequest, QuickAddInventoryResponse } from '@tcg/shared';
import { api } from '../../lib/api';

/**
 * Add a scanned/identified card straight into inventory as a raw single.
 * Creates the product + SKU if needed and receives an initial quantity at the
 * operator's chosen sell price (prefilled from PkmnPrices market in the UI).
 */
export function useQuickAddInventory() {
  return useMutation<QuickAddInventoryResponse, Error, QuickAddInventoryRequest>({
    mutationFn: (body) => api.post<QuickAddInventoryResponse>('/products/quick-add', body),
  });
}
