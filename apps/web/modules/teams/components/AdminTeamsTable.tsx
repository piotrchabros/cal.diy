"use client";

import type { TeamWithOrganizationDto } from "@calcom/lib/dto/TeamWithOrganizationDto";
import { useDebounce } from "@calcom/lib/hooks/useDebounce";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import { Button } from "@calcom/ui/components/button";
import { TextField } from "@calcom/ui/components/form";
import { Table } from "@calcom/ui/components/table";
import { keepPreviousData } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { OrganizationSelect } from "../../organizations/components/OrganizationSelect";

const { Body, Cell, ColumnTitle, Header } = Table;

const FETCH_LIMIT = 25;
const EMPTY_VALUE = "—";

export function AdminTeamsTable() {
  const { t } = useLocale();
  const [searchTerm, setSearchTerm] = useState("");
  const debouncedSearchTerm = useDebounce(searchTerm, 500);
  const [organizationId, setOrganizationId] = useState<number | null>(null);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isPending, isError } =
    trpc.viewer.admin.teams.listPaginated.useInfiniteQuery(
      { limit: FETCH_LIMIT, searchTerm: debouncedSearchTerm || null, organizationId },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        placeholderData: keepPreviousData,
        refetchOnWindowFocus: false,
      }
    );

  const teams: TeamWithOrganizationDto[] = useMemo(
    () => data?.pages.flatMap((page) => page.rows) ?? [],
    [data]
  );
  const totalRowCount = data?.pages[0]?.meta.totalRowCount ?? 0;

  const renderContent = () => {
    if (isPending) return <p className="text-sm text-subtle">{t("loading")}</p>;
    if (isError) return <p className="text-error text-sm">{t("something_went_wrong")}</p>;
    if (teams.length === 0) {
      return (
        <p className="text-sm text-subtle" data-testid="admin-teams-empty">
          {t("no_teams_found")}
        </p>
      );
    }

    return (
      <>
        <p className="text-sm text-subtle">{t("showing_x_of_y", { x: teams.length, y: totalRowCount })}</p>
        <Table>
          <Header>
            <ColumnTitle widthClassNames="w-auto">{t("name")}</ColumnTitle>
            <ColumnTitle>{t("slug")}</ColumnTitle>
            <ColumnTitle>{t("members")}</ColumnTitle>
            <ColumnTitle>{t("organization")}</ColumnTitle>
          </Header>
          <Body>
            {teams.map((team) => (
              // Table.Row does not forward props, so a plain row carries the test id.
              <tr key={team.id} data-testid={`admin-team-row-${team.id}`}>
                <Cell widthClassNames="w-auto">
                  <span className="text-default">{team.name}</span>
                </Cell>
                <Cell>{team.slug ?? EMPTY_VALUE}</Cell>
                <Cell>{team.memberCount}</Cell>
                <Cell>{team.organization?.name ?? t("none")}</Cell>
              </tr>
            ))}
          </Body>
        </Table>
        {hasNextPage && (
          <div className="flex justify-center">
            <Button color="secondary" loading={isFetchingNextPage} onClick={() => fetchNextPage()}>
              {t("load_more_results")}
            </Button>
          </div>
        )}
      </>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <TextField
        label={t("search")}
        placeholder={t("admin_teams_search_placeholder")}
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
      />
      <OrganizationSelect value={organizationId} onChange={setOrganizationId} />
      {renderContent()}
    </div>
  );
}
