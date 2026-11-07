"use client";

// NEAR wallet sign-in (wallet-selector: MyNearWallet + Meteor). Loaded lazily, client-only.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { WalletSelector } from "@near-wallet-selector/core";
import type { WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { NEAR_NETWORK } from "./near";

interface FunctionCall {
  receiverId: string;
  method: string;
  args: Record<string, unknown>;
  /** in Tgas */
  tgas: number;
  depositYocto?: string;
}

interface WalletCtx {
  ready: boolean;
  accountId: string | null;
  signIn: () => void;
  signOut: () => Promise<void>;
  /** Resolves with the tx hash. Browser wallets (MyNearWallet) redirect away and back instead. */
  call: (fc: FunctionCall) => Promise<string | null>;
}

const Ctx = createContext<WalletCtx | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const selectorRef = useRef<WalletSelector | null>(null);
  const modalRef = useRef<WalletSelectorModal | null>(null);
  const [ready, setReady] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(null);

  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const [{ setupWalletSelector }, { setupModal }, { setupMyNearWallet }, { setupMeteorWallet }] = await Promise.all([
        import("@near-wallet-selector/core"),
        import("@near-wallet-selector/modal-ui"),
        import("@near-wallet-selector/my-near-wallet"),
        import("@near-wallet-selector/meteor-wallet"),
      ]);
      const selector = await setupWalletSelector({ network: NEAR_NETWORK, modules: [setupMyNearWallet(), setupMeteorWallet()] });
      if (cancelled) return;
      selectorRef.current = selector;
      modalRef.current = setupModal(selector, { description: "Sign in with a DAO council account to vote on payment proposals." });
      const sync = () => setAccountId(selector.store.getState().accounts.find((a) => a.active)?.accountId ?? null);
      sync();
      const sub = selector.store.observable.subscribe(sync);
      off = () => sub.unsubscribe();
      setReady(true);
    })().catch((e) => console.warn("[wallet] init failed", e));
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  const signIn = useCallback(() => modalRef.current?.show(), []);
  const signOut = useCallback(async () => {
    const s = selectorRef.current;
    if (!s?.isSignedIn()) return;
    await (await s.wallet()).signOut();
  }, []);
  const call = useCallback(async (fc: FunctionCall) => {
    const s = selectorRef.current;
    if (!s?.isSignedIn()) throw new Error("Connect a wallet first");
    const { actionCreators } = await import("@near-js/transactions");
    const wallet = await s.wallet();
    const outcome = await wallet.signAndSendTransaction({
      receiverId: fc.receiverId,
      actions: [actionCreators.functionCall(fc.method, fc.args, BigInt(fc.tgas) * BigInt(1e12), BigInt(fc.depositYocto ?? "0"))],
    });
    const o = outcome as { transaction_outcome?: { id?: string }; status?: { Failure?: unknown } } | undefined;
    if (o?.status && typeof o.status === "object" && "Failure" in o.status && o.status.Failure) {
      throw new Error(`Transaction failed: ${JSON.stringify(o.status.Failure).slice(0, 200)}`);
    }
    return o?.transaction_outcome?.id ?? null;
  }, []);

  const value = useMemo(() => ({ ready, accountId, signIn, signOut, call }), [ready, accountId, signIn, signOut, call]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet outside WalletProvider");
  return v;
}
