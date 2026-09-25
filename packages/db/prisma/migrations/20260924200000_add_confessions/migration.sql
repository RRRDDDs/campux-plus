-- CreateTable
CREATE TABLE "Confession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "matchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Confession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Confession_tenantId_toUserId_status_idx" ON "Confession"("tenantId", "toUserId", "status");

-- CreateIndex
CREATE INDEX "Confession_tenantId_createdAt_idx" ON "Confession"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Confession_tenantId_fromUserId_toUserId_status_key" ON "Confession"("tenantId", "fromUserId", "toUserId", "status");

-- AddForeignKey
ALTER TABLE "Confession" ADD CONSTRAINT "Confession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confession" ADD CONSTRAINT "Confession_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confession" ADD CONSTRAINT "Confession_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
