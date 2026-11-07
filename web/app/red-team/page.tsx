import type { Metadata } from "next";
import { AttackLab } from "./attack-lab";

export const metadata: Metadata = {
  title: "Red team",
  description: "Hold a compromised AI agent's key and try to drain a DAO treasury on NEAR testnet.",
};

export default function RedTeamPage() {
  return <AttackLab />;
}
