import { apiClient } from './client';
import type { HistorySample } from '@/features/quota/poolModel';

export interface QuotaHistoryResponse {
  enabled: boolean;
  retention_days?: number;
  since?: number;
  until?: number;
  samples: HistorySample[];
}

/** Recorded passive quota readings (server build with quota history). */
export const quotaHistoryApi = {
  list: (params: { sinceMs: number; untilMs: number; provider?: string }) =>
    apiClient.get<QuotaHistoryResponse>('/quota-history', {
      params: {
        since: Math.floor(params.sinceMs / 1000),
        until: Math.floor(params.untilMs / 1000),
        provider: params.provider,
      },
    }),
};
