-- BlueBee switch-over (specs/005-organizations data-model.md Change 2). Data only, no DDL.
-- Repeat-safe: every step skips rows it already handled, so a second run changes nothing.
-- Runs as one DO block so it is atomic: a failed pre-check or step leaves the database untouched.
-- Users without a username get organizationId and the membership but no Profile, because
-- Profile.username is NOT NULL; profile lookups fall back to the personal profile for them.
-- WARNING: apply this in the same window as turning ORGANIZATIONS_ENABLED on. With the flag off,
-- public user/team lookups match only rows without an organization (organizationId / parentId NULL),
-- so after this runs those booking pages return 404 until the flag is enabled (follow-up T221).
-- Do not run db-deploy with this migration pending while the flag must stay off.
DO $$
DECLARE
  bluebee_id INTEGER;
  conflict_list TEXT;
  rows_changed INTEGER;
BEGIN
  RAISE NOTICE 'BEFORE: users=%, users_without_org=%, top_level_teams_without_org=%, organizations=%, profiles=%, memberships=%',
    (SELECT count(*) FROM "users"),
    (SELECT count(*) FROM "users" WHERE "organizationId" IS NULL),
    (SELECT count(*) FROM "Team" WHERE "isOrganization" = false AND "parentId" IS NULL),
    (SELECT count(*) FROM "Team" WHERE "isOrganization" = true AND "parentId" IS NULL),
    (SELECT count(*) FROM "Profile"),
    (SELECT count(*) FROM "Membership");

  -- Pre-checks: fail loudly instead of half-applying when the data breaks an assumption of the spec.
  IF EXISTS (
    SELECT 1 FROM "Team" WHERE "slug" = 'bluebee' AND "parentId" IS NULL AND "isOrganization" = false
  ) THEN
    RAISE EXCEPTION 'BlueBee switch-over aborted: a top-level non-organization team already uses slug "bluebee"';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "OrganizationSettings" s
    JOIN "Team" t ON t."id" = s."organizationId"
    WHERE s."customDomain" = 'cal.bluebee.marketing' AND t."slug" IS DISTINCT FROM 'bluebee'
  ) THEN
    RAISE EXCEPTION 'BlueBee switch-over aborted: domain cal.bluebee.marketing belongs to another organization';
  END IF;

  SELECT "id" INTO bluebee_id FROM "Team"
  WHERE "slug" = 'bluebee' AND "isOrganization" = true AND "parentId" IS NULL;

  -- Usernames and team slugs become unique per organization; Postgres treats NULL org ids as
  -- distinct, so duplicates among org-less rows would surface only as a unique violation mid-run.
  SELECT string_agg(DISTINCT u."username", ', ') INTO conflict_list
  FROM (
    SELECT "username" FROM "users"
    WHERE "username" IS NOT NULL
      AND ("organizationId" IS NULL OR "organizationId" = bluebee_id)
    GROUP BY "username" HAVING count(*) > 1
  ) u;
  IF conflict_list IS NOT NULL THEN
    RAISE EXCEPTION 'BlueBee switch-over aborted: duplicate usernames would collide in BlueBee: %', conflict_list;
  END IF;

  SELECT string_agg(DISTINCT t."slug", ', ') INTO conflict_list
  FROM (
    SELECT "slug" FROM "Team"
    WHERE "isOrganization" = false
      AND "slug" IS NOT NULL
      AND ("parentId" IS NULL OR "parentId" = bluebee_id)
    GROUP BY "slug" HAVING count(*) > 1
  ) t;
  IF conflict_list IS NOT NULL THEN
    RAISE EXCEPTION 'BlueBee switch-over aborted: duplicate team slugs would collide in BlueBee: %', conflict_list;
  END IF;

  -- 1. The BlueBee organization
  IF bluebee_id IS NULL THEN
    INSERT INTO "Team" ("name", "slug", "isOrganization", "parentId")
    VALUES ('BlueBee', 'bluebee', true, NULL)
    RETURNING "id" INTO bluebee_id;
    RAISE NOTICE 'step 1: created organization BlueBee (id=%)', bluebee_id;
  ELSE
    RAISE NOTICE 'step 1: organization BlueBee already exists (id=%)', bluebee_id;
  END IF;

  -- 2. Its settings. allowSEOIndexing = true keeps public booking pages indexable once the flag is on.
  -- orgAutoAcceptEmail stays empty so sign-ups are never auto-joined by email domain.
  INSERT INTO "OrganizationSettings" (
    "organizationId", "customDomain", "isOrganizationConfigured", "isOrganizationVerified",
    "orgAutoAcceptEmail", "allowSEOIndexing"
  )
  VALUES (bluebee_id, 'cal.bluebee.marketing', true, true, '', true)
  ON CONFLICT ("organizationId") DO NOTHING;
  GET DIAGNOSTICS rows_changed = ROW_COUNT;
  RAISE NOTICE 'step 2: organization settings inserted=%', rows_changed;

  UPDATE "OrganizationSettings" SET "customDomain" = 'cal.bluebee.marketing'
  WHERE "organizationId" = bluebee_id AND "customDomain" IS NULL;
  GET DIAGNOSTICS rows_changed = ROW_COUNT;
  RAISE NOTICE 'step 2: missing custom domain filled=%', rows_changed;

  -- 3. Every top-level team joins BlueBee
  UPDATE "Team" SET "parentId" = bluebee_id
  WHERE "isOrganization" = false AND "parentId" IS NULL;
  GET DIAGNOSTICS rows_changed = ROW_COUNT;
  RAISE NOTICE 'step 3: teams moved into BlueBee=%', rows_changed;

  -- 4. Every user without an organization joins BlueBee
  UPDATE "users" SET "organizationId" = bluebee_id
  WHERE "organizationId" IS NULL;
  GET DIAGNOSTICS rows_changed = ROW_COUNT;
  RAISE NOTICE 'step 4: users moved into BlueBee=%', rows_changed;

  -- 5. A BlueBee profile per member that has a username
  INSERT INTO "Profile" ("uid", "userId", "organizationId", "username", "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text, u."id", bluebee_id, u."username", now(), now()
  FROM "users" u
  WHERE u."organizationId" = bluebee_id
    AND u."username" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "Profile" p WHERE p."userId" = u."id" AND p."organizationId" = bluebee_id
    )
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS rows_changed = ROW_COUNT;
  RAISE NOTICE 'step 5: profiles created=%', rows_changed;

  -- 6. An accepted BlueBee membership per member: instance admins own the organization
  INSERT INTO "Membership" ("teamId", "userId", "accepted", "role", "createdAt", "updatedAt")
  SELECT bluebee_id, u."id", true,
    CASE WHEN u."role" = 'ADMIN' THEN 'OWNER'::"MembershipRole" ELSE 'MEMBER'::"MembershipRole" END,
    now(), now()
  FROM "users" u
  WHERE u."organizationId" = bluebee_id
    AND NOT EXISTS (
      SELECT 1 FROM "Membership" m WHERE m."userId" = u."id" AND m."teamId" = bluebee_id
    )
  ON CONFLICT ("userId", "teamId") DO NOTHING;
  GET DIAGNOSTICS rows_changed = ROW_COUNT;
  RAISE NOTICE 'step 6: memberships created=%', rows_changed;

  IF NOT EXISTS (
    SELECT 1 FROM "Membership" WHERE "teamId" = bluebee_id AND "role" = 'OWNER' AND "accepted" = true
  ) THEN
    RAISE WARNING 'BlueBee has no OWNER (no user has role ADMIN); assign one before enabling organizations';
  END IF;

  RAISE NOTICE 'AFTER: users=%, users_without_org=%, top_level_teams_without_org=%, organizations=%, profiles=%, memberships=%',
    (SELECT count(*) FROM "users"),
    (SELECT count(*) FROM "users" WHERE "organizationId" IS NULL),
    (SELECT count(*) FROM "Team" WHERE "isOrganization" = false AND "parentId" IS NULL),
    (SELECT count(*) FROM "Team" WHERE "isOrganization" = true AND "parentId" IS NULL),
    (SELECT count(*) FROM "Profile"),
    (SELECT count(*) FROM "Membership");

  RAISE NOTICE 'AFTER (BlueBee id=%): members=%, owners=%, profiles=%, members_without_username=%, teams=%',
    bluebee_id,
    (SELECT count(*) FROM "users" WHERE "organizationId" = bluebee_id),
    (SELECT count(*) FROM "Membership" WHERE "teamId" = bluebee_id AND "role" = 'OWNER'),
    (SELECT count(*) FROM "Profile" WHERE "organizationId" = bluebee_id),
    (SELECT count(*) FROM "users" WHERE "organizationId" = bluebee_id AND "username" IS NULL),
    (SELECT count(*) FROM "Team" WHERE "parentId" = bluebee_id);
END $$;
