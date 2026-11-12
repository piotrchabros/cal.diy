-- CreateTable
CREATE TABLE "public"."OrganizationNotetakerSettings" (
    "organizationId" INTEGER NOT NULL,
    "botName" TEXT,
    "botImageJpeg" TEXT,
    "botImageUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationNotetakerSettings_pkey" PRIMARY KEY ("organizationId")
);

-- AddForeignKey
ALTER TABLE "public"."OrganizationNotetakerSettings" ADD CONSTRAINT "OrganizationNotetakerSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
