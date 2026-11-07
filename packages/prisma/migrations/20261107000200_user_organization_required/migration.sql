-- users.organizationId becomes required (specs/005-organizations data-model.md Change 3, T062).
-- Apply only after 20261107000100_organizations_bluebee_switchover (T061) has given every user an
-- organization; this aborts, leaving the database untouched, if any user still has none.
DO $$
DECLARE
  users_without_org INTEGER;
BEGIN
  SELECT count(*) INTO users_without_org FROM "public"."users" WHERE "organizationId" IS NULL;
  IF users_without_org > 0 THEN
    RAISE EXCEPTION 'users.organizationId cannot become NOT NULL: % user(s) have no organization', users_without_org
      USING HINT = 'Apply the BlueBee switch-over migration (20261107000100_organizations_bluebee_switchover, T061) first';
  END IF;
END $$;

-- DropForeignKey
ALTER TABLE "public"."users" DROP CONSTRAINT "users_organizationId_fkey";

-- AlterTable
ALTER TABLE "public"."users" ALTER COLUMN "organizationId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "public"."users" ADD CONSTRAINT "users_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
