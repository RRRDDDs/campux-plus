-- CreateTable
CREATE TABLE "TenantApplication" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "wallName" TEXT NOT NULL,
    "school" TEXT,
    "contact" TEXT,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewNote" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TenantApplication_status_createdAt_idx" ON "TenantApplication"("status", "createdAt");

-- CreateIndex
CREATE INDEX "TenantApplication_userId_createdAt_idx" ON "TenantApplication"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "TenantApplication" ADD CONSTRAINT "TenantApplication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantApplication" ADD CONSTRAINT "TenantApplication_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
