-- AlterTable
ALTER TABLE "OrganizationSettings" ADD COLUMN     "customDomain" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationSettings_customDomain_key" ON "OrganizationSettings"("customDomain");
