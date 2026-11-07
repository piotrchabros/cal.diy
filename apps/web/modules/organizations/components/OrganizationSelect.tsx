"use client";

import { useDebounce } from "@calcom/lib/hooks/useDebounce";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import { Label, Select } from "@calcom/ui/components/form";
import { keepPreviousData } from "@tanstack/react-query";
import { useState } from "react";

const ORGANIZATION_SEARCH_LIMIT = 20;

type OrganizationOption = { value: number; label: string };

export function OrganizationSelect({
  value,
  onChange,
  excludeOrganizationId,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  excludeOrganizationId?: number | null;
}) {
  const { t } = useLocale();
  const [searchTerm, setSearchTerm] = useState("");
  const [selected, setSelected] = useState<OrganizationOption | null>(null);
  const debouncedSearchTerm = useDebounce(searchTerm, 300);

  const { data, isFetching } = trpc.viewer.admin.organizations.list.useQuery(
    { search: debouncedSearchTerm || undefined, limit: ORGANIZATION_SEARCH_LIMIT },
    { placeholderData: keepPreviousData }
  );

  const options: OrganizationOption[] = (data?.items ?? [])
    .filter((organization) => organization.id !== excludeOrganizationId)
    .map((organization) => ({
      value: organization.id,
      label: organization.domain ? `${organization.name} (${organization.domain})` : organization.name,
    }));

  // The chosen organization can drop out of the options once the search term changes
  const selectedOption =
    value === null
      ? null
      : (options.find((option) => option.value === value) ?? (selected?.value === value ? selected : null));

  return (
    <div>
      <Label htmlFor="target-organization">{t("organization")}</Label>
      <Select<OrganizationOption>
        inputId="target-organization"
        options={options}
        value={selectedOption}
        onChange={(option) => {
          setSelected(option ?? null);
          onChange(option?.value ?? null);
        }}
        isLoading={isFetching}
        isClearable
        // Filtering happens server-side; react-select would otherwise hide matches on the domain
        filterOption={null}
        onInputChange={(input, meta) => {
          if (meta.action === "input-change") setSearchTerm(input);
        }}
        placeholder={t("organization_search_placeholder")}
      />
    </div>
  );
}
