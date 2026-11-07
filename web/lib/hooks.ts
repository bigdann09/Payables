"use client";

import { useEffect, useSyncExternalStore } from "react";
import useSWR, { useSWRConfig, type SWRConfiguration } from "swr";
import { api, dataSource } from "./api";
import { onMockChange } from "./mock-store";
import type { InvoiceStatus } from "./types";

const opts: SWRConfiguration = { refreshInterval: 10_000, revalidateOnFocus: true, keepPreviousData: true };

export const useCompany = () => useSWR("company", api.getCompany, opts);
export const useStats = () => useSWR("stats", api.getStats, opts);
export const useInvoices = (status?: InvoiceStatus) =>
  useSWR(["invoices", status ?? "all"], () => api.listInvoices(status), opts);
const LIVE_STATUSES = ["received", "extracting", "scheduled", "paying", "pending_approval"];
/** Polls fast (2.5s) while the invoice is in a transitional status. */
export const useInvoice = (id: string) =>
  useSWR(["invoice", id], () => api.getInvoice(id), {
    ...opts,
    keepPreviousData: false,
    refreshInterval: (d) => (!d || LIVE_STATUSES.includes(d.status) ? 2500 : 10_000),
  });
export const usePayees = () => useSWR("payees", api.listPayees, opts);
export const usePurchaseOrders = () => useSWR("purchase-orders", api.listPurchaseOrders, opts);
export const useFlagged = () => useSWR("flagged", api.listFlagged, opts);
export const useActivity = () => useSWR("activity", api.listActivity, opts);

/** Revalidate everything (after mutations). */
export function useRefreshAll() {
  const { mutate } = useSWRConfig();
  return () => mutate(() => true);
}

/** When mocks mutate on a timer (simulated agent), revalidate all SWR keys. */
export function useMockSync() {
  const { mutate } = useSWRConfig();
  useEffect(() => {
    const off = onMockChange(() => {
      mutate(() => true);
    });
    return () => {
      off();
    };
  }, [mutate]);
}

export function useDataSource() {
  return useSyncExternalStore(dataSource.subscribe, dataSource.get, () => "unknown" as const);
}
