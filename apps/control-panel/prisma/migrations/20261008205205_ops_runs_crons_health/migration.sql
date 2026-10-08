-- CreateEnum
CREATE TYPE "MigrationRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "MigrationRun" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "status" "MigrationRunStatus" NOT NULL DEFAULT 'RUNNING',
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "fromVersion" TEXT,
    "toVersion" TEXT,
    "pending" TEXT[],
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "triggeredBy" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "MigrationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CronState" (
    "subscriptionId" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastHttp" INTEGER,
    "lastDurationMs" INTEGER,
    "lastError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CronState_pkey" PRIMARY KEY ("subscriptionId","job")
);

-- CreateTable
CREATE TABLE "TenantHealth" (
    "subscriptionId" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "latencyMs" INTEGER,
    "dbOk" BOOLEAN,
    "schemaApplied" TEXT,
    "schemaExpected" TEXT,
    "schemaUpToDate" BOOLEAN,
    "onboardingComplete" BOOLEAN,
    "onboardingMissing" TEXT[],
    "version" TEXT,
    "error" TEXT,

    CONSTRAINT "TenantHealth_pkey" PRIMARY KEY ("subscriptionId")
);

-- CreateIndex
CREATE INDEX "MigrationRun_subscriptionId_startedAt_idx" ON "MigrationRun"("subscriptionId", "startedAt");

-- CreateIndex
CREATE INDEX "MigrationRun_status_idx" ON "MigrationRun"("status");

-- CreateIndex
CREATE INDEX "CronState_job_nextRunAt_idx" ON "CronState"("job", "nextRunAt");

-- AddForeignKey
ALTER TABLE "MigrationRun" ADD CONSTRAINT "MigrationRun_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CronState" ADD CONSTRAINT "CronState_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantHealth" ADD CONSTRAINT "TenantHealth_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
