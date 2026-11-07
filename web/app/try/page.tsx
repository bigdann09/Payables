import type { Metadata } from "next";
import { AttackLab } from "./attack-lab";

export const metadata: Metadata = {
  title: "Try to break it",
  description: "Attack a live NEAR testnet payment contract from your browser. No wallet needed.",
};

export default function TryPage() {
  return <AttackLab />;
}
