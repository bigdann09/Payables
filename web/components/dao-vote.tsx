"use client";

import { useState } from "react";
import useSWR from "swr";
import { Check, ExternalLink, Landmark, ShieldCheck, Wallet, X } from "lucide-react";
import { DAO_PROPOSAL_URL, EXPLORER_TX, cn, shortHash } from "@/lib/format";
import { getPolicy, getProposal, proposalKindName, voters } from "@/lib/near";
import { useWallet } from "@/lib/wallet";
import { Pill } from "./status";
import { Button, Mono } from "./ui";

const STATUS_TONE = { InProgress: "violet", Approved: "ok", Rejected: "danger", Removed: "neutral", Expired: "neutral", Moved: "neutral", Failed: "danger" } as const;

/**
 * Vote on a Sputnik proposal from the browser: reads the proposal + council from RPC and sends act_proposal
 * from the connected wallet. The API's chain-sync picks up the outcome (release/reject) on its next tick.
 */
export function DaoVote({ daoId, proposalId, onVoted, className }: { daoId: string; proposalId: string | number; onVoted?: () => void; className?: string }) {
  const id = Number(proposalId);
  const { accountId, signIn, call, ready } = useWallet();
  const proposal = useSWR(["dao-proposal", daoId, id], () => getProposal(daoId, id), { refreshInterval: 5000 });
  const policy = useSWR(["dao-policy", daoId], () => getPolicy(daoId));
  const [busy, setBusy] = useState<"VoteApprove" | "VoteReject" | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const p = proposal.data;
  const council = policy.data ? voters(policy.data) : [];
  const isVoter = !!accountId && council.includes(accountId);
  const myVote = accountId ? p?.votes[accountId] : undefined;
  const open = p?.status === "InProgress";

  async function vote(action: "VoteApprove" | "VoteReject") {
    if (!p) return;
    setBusy(action);
    setErr(null);
    try {
      // Sputnik requires the proposal kind to be echoed back, so a vote can't be replayed onto a different proposal.
      const hash = await call({ receiverId: daoId, method: "act_proposal", args: { id, action, proposal: p.kind }, tgas: 250 });
      setTx(hash);
      await proposal.mutate();
      onVoted?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={cn("rounded-lg border border-violet/30 bg-surface", className)}>
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-violet-soft text-violet">
            <Landmark className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">
              DAO proposal #{id} <span className="font-normal text-muted">· {p ? proposalKindName(p.kind) : "loading"}</span>
            </div>
            <div className="num truncate text-xs text-muted">{daoId}</div>
          </div>
        </div>
        {p && (
          <Pill tone={STATUS_TONE[p.status] ?? "neutral"} dot pulse={open}>
            {p.status === "InProgress" ? "Voting open" : p.status}
          </Pill>
        )}
      </div>

      <div className="space-y-3 px-4 py-3 text-[13px]">
        {proposal.error && <div className="text-danger">Could not load the proposal from NEAR RPC.</div>}
        {p && <p className="text-muted">{p.description}</p>}

        {p && (
          <div className="flex flex-wrap gap-1.5">
            {council.map((a) => (
              <span key={a} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs">
                {p.votes[a] === "Approve" ? <Check className="h-3 w-3 text-ok" /> : p.votes[a] === "Reject" ? <X className="h-3 w-3 text-danger" /> : <span className="h-1.5 w-1.5 rounded-full bg-border-strong" />}
                <span className="num">{a}</span>
              </span>
            ))}
          </div>
        )}

        {open && !accountId && (
          <Button size="sm" variant="secondary" onClick={signIn} disabled={!ready}>
            <Wallet className="h-3.5 w-3.5" /> Connect a council wallet to vote
          </Button>
        )}
        {open && accountId && !isVoter && policy.data && (
          <div className="rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn">
            <Mono>{accountId}</Mono> is not on this DAO&apos;s council, so the DAO would refuse its vote.
          </div>
        )}
        {open && isVoter && !myVote && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => vote("VoteApprove")} loading={busy === "VoteApprove"} disabled={!!busy}>
              <Check className="h-3.5 w-3.5" /> Approve and release
            </Button>
            <Button size="sm" variant="secondary" onClick={() => vote("VoteReject")} loading={busy === "VoteReject"} disabled={!!busy}>
              <X className="h-3.5 w-3.5" /> Reject
            </Button>
          </div>
        )}
        {myVote && (
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <ShieldCheck className="h-3.5 w-3.5 text-ok" /> You voted <b className="text-fg">{myVote}</b>
            {open ? "; waiting for the other council members." : "."}
          </div>
        )}
        {tx && (
          <a href={EXPLORER_TX(tx)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
            Vote transaction <Mono>{shortHash(tx)}</Mono> <ExternalLink className="h-3 w-3" />
          </a>
        )}
        {err && <div className="break-words text-xs text-danger">{err}</div>}

        <a href={DAO_PROPOSAL_URL(daoId, id)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
          Open in AstroDAO <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  );
}
