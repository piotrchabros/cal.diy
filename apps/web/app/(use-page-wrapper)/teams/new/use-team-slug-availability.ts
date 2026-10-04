"use client";

import { useDebounce } from "@calcom/lib/hooks/useDebounce";
import slugify from "@calcom/lib/slugify";
import { trpc } from "@calcom/trpc/react";

const SLUG_CHECK_DEBOUNCE_MS = 400;

export function useTeamSlugAvailability(slug: string) {
  const normalizedSlug = slugify(slug);
  const debouncedSlug = useDebounce(normalizedSlug, SLUG_CHECK_DEBOUNCE_MS);

  const query = trpc.viewer.teams.isSlugAvailable.useQuery(
    { slug: debouncedSlug },
    { enabled: debouncedSlug.length > 0, retry: false }
  );

  const isChecking = debouncedSlug !== normalizedSlug || query.isFetching;
  const isAvailable = query.data && query.data.slug === debouncedSlug ? query.data.available : undefined;

  return { normalizedSlug, isChecking, isAvailable };
}
