// Browser-side NEAR reads (no wallet needed): DAO proposals and policy, straight from RPC.

export const NEAR_NETWORK = (process.env.NEXT_PUBLIC_NEAR_NETWORK || "testnet") as "testnet" | "mainnet";
export const NEAR_RPC = process.env.NEXT_PUBLIC_NEAR_RPC_URL || "https://rpc.testnet.fastnear.com";

export async function viewCall<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(NEAR_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "payables",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "optimistic",
        account_id: contractId,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    }),
  });
  const json = (await res.json()) as { result?: { result?: number[] }; error?: { message?: string; data?: string } };
  if (json.error || !json.result?.result) throw new Error(json.error?.data || json.error?.message || `view ${method} failed`);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(json.result.result))) as T;
}

export type ProposalStatus = "InProgress" | "Approved" | "Rejected" | "Removed" | "Expired" | "Moved" | "Failed";
export interface DaoProposal {
  id: number;
  proposer: string;
  description: string;
  /** Sputnik ProposalKind; must be echoed back verbatim in act_proposal. */
  kind: Record<string, unknown>;
  status: ProposalStatus;
  votes: Record<string, "Approve" | "Reject" | "Remove">;
  submission_time: string;
}
interface DaoRole {
  name: string;
  kind: "Everyone" | { Group: string[] } | { Member: string };
  permissions: string[];
}
interface DaoPolicy {
  roles: DaoRole[];
  proposal_period: string;
}

export const getProposal = (daoId: string, id: number) => viewCall<DaoProposal>(daoId, "get_proposal", { id });
export const getPolicy = (daoId: string) => viewCall<DaoPolicy>(daoId, "get_policy");

/** Accounts that can vote on proposals (Group roles with a vote permission). */
export function voters(policy: DaoPolicy): string[] {
  const out = new Set<string>();
  for (const r of policy.roles) {
    const canVote = r.permissions.some((p) => /^(\*|[a-z_]+):(\*|Vote(Approve|Reject)?)$/i.test(p) || p === "*:*");
    if (canVote && typeof r.kind === "object" && "Group" in r.kind) r.kind.Group.forEach((a) => out.add(a));
  }
  return [...out];
}

export function proposalKindName(kind: Record<string, unknown>): string {
  const k = Object.keys(kind)[0] ?? "Unknown";
  return k.replace(/([a-z])([A-Z])/g, "$1 $2");
}
