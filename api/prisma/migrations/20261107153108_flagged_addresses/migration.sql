-- CreateTable
CREATE TABLE "FlaggedAddress" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "amount" TEXT,
    "invoiceId" TEXT,
    "hits" INTEGER NOT NULL DEFAULT 1,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FlaggedAddress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FlaggedAddress_companyId_lastSeen_idx" ON "FlaggedAddress"("companyId", "lastSeen");

-- CreateIndex
CREATE UNIQUE INDEX "FlaggedAddress_companyId_account_key" ON "FlaggedAddress"("companyId", "account");

-- AddForeignKey
ALTER TABLE "FlaggedAddress" ADD CONSTRAINT "FlaggedAddress_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
