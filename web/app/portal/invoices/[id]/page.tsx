import { Suspense } from "react";
import { Skeleton } from "@/components/ui";
import { PortalStatus } from "./portal-status";

export default function PortalStatusPage() {
  return (
    <Suspense fallback={<Skeleton className="h-72" />}>
      <PortalStatus />
    </Suspense>
  );
}
