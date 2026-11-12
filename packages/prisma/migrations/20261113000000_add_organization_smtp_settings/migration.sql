-- CreateEnum
CREATE TYPE "public"."OrganizationSmtpSecurity" AS ENUM ('SSL', 'STARTTLS', 'NONE');

-- CreateTable
CREATE TABLE "public"."OrganizationSmtpSettings" (
    "organizationId" INTEGER NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "security" "public"."OrganizationSmtpSecurity" NOT NULL,
    "username" TEXT,
    "passwordEncrypted" TEXT,
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationSmtpSettings_pkey" PRIMARY KEY ("organizationId")
);

-- AddForeignKey
ALTER TABLE "public"."OrganizationSmtpSettings" ADD CONSTRAINT "OrganizationSmtpSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
