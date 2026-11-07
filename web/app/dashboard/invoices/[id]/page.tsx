import { Suspense } from "react";
import { Skeleton } from "@/components/ui";
import { InvoiceDetail } from "./invoice-detail";

export default function InvoiceDetailPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <InvoiceDetail />
    </Suspense>
  );
}
