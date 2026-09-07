import { useMutation, useQuery } from '@tanstack/react-query';
import type { VisionIdentifyResponse, VisionStatusResponse } from '@tcg/shared';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/queryKeys';

/**
 * Capability probe for the camera "snap-to-identify" feature. Returns whether
 * the server has a vision model configured (`enabled`) and whether PkmnPrices
 * pricing is set up for the store (`pricingConfigured`). The UI uses `enabled`
 * to decide whether to show the camera button at all.
 */
export function useVisionStatus(active: boolean) {
  return useQuery<VisionStatusResponse>({
    queryKey: queryKeys.vision.status(),
    queryFn: () => api.get<VisionStatusResponse>('/vision/status'),
    enabled: active,
    // Capability rarely changes within a session; avoid re-probing on focus.
    staleTime: 10 * 60_000,
  });
}

/**
 * Send a captured card photo (image data URL) to the vision identify endpoint.
 * Resolves with the extracted identity plus priced catalog candidates. The
 * caller shows a confirmation panel before adding anything to a transaction.
 */
export function useIdentifyCardFromImage() {
  return useMutation<VisionIdentifyResponse, Error, string>({
    mutationFn: (dataUrl: string) =>
      api.post<VisionIdentifyResponse>('/vision/identify-card', { dataUrl }),
  });
}
