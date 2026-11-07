"use client";

import { useDebounce } from "@calcom/lib/hooks/useDebounce";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import { Button } from "@calcom/ui/components/button";
import { TextField } from "@calcom/ui/components/form";
import { Table } from "@calcom/ui/components/table";
import { keepPreviousData } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { MoveTeamDialogTeam } from "./MoveTeamDialog";
import { MoveTeamDialog } from "./MoveTeamDialog";

const { Body, Cell, ColumnTitle, Header } = Table;

const FETCH_LIMIT = 50;
const EMPTY_VALUE = "—";

export function OrganizationTeamsSection({ organizationId }: { organizationId: number }) {
  const { t } = useLocale();
  const [searchTerm, setSearchTerm] = useState("");
  const [teamToMove, setTeamToMove] = useState<MoveTeamDialogTeam | null>(null);
  const debouncedSearchTerm = useDebounce(searchTerm, 300);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isPending } =
    trpc.viewer.admin.organizations.listTeams.useInfiniteQuery(
      { organizationId, search: debouncedSearchTerm || undefined, limit: FETCH_LIMIT },
      { getNextPageParam: (lastPage) => lastPage.nextCursor, placeholderData: keepPreviousData }
    );

  const teams = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);

  const renderContent = () => {
    if (isPending) return <p className="text-sm text-subtle">{t("loading")}</p>;
    if (teams.length === 0) {
      return (
        <p className="text-sm text-subtle" data-testid="organization-teams-empty">
          {t("no_organization_teams_found")}
        </p>
      );
    }

    return (
      <>
        <Table>
          <Header>
            <ColumnTitle widthClassNames="w-auto">{t("name")}</ColumnTitle>
            <ColumnTitle>{t("slug")}</ColumnTitle>
            <ColumnTitle>{t("members")}</ColumnTitle>
            <ColumnTitle widthClassNames="w-auto">
              <span className="sr-only">{t("move_to_organization")}</span>
            </ColumnTitle>
          </Header>
          <Body>
            {teams.map((team) => (
              // Table.Row does not forward props, so a plain row carries the test id.
              <tr key={team.teamId} data-testid={`organization-team-row-${team.teamId}`}>
                <Cell widthClassNames="w-auto">{team.name}</Cell>
                <Cell>{team.slug ?? EMPTY_VALUE}</Cell>
                <Cell>{team.memberCount}</Cell>
                <Cell widthClassNames="w-auto">
                  <div className="flex w-full justify-end">
                    <Button
                      color="secondary"
                      size="sm"
                      onClick={() =>
                        setTeamToMove({ teamId: team.teamId, name: team.name, slug: team.slug })
                      }>
                      {t("move")}
                    </Button>
                  </div>
                </Cell>
              </tr>
            ))}
          </Body>
        </Table>
        {hasNextPage && (
          <div className="flex justify-center">
            <Button color="secondary" loading={isFetchingNextPage} onClick={() => fetchNextPage()}>
              {t("load_more")}
            </Button>
          </div>
        )}
      </>
    );
  };

  return (
    <section className="mt-8 flex flex-col gap-3" data-testid="organization-teams-section">
      <h2 className="font-semibold text-emphasis">{t("organization_teams")}</h2>
      <TextField
        label={t("search")}
        placeholder={t("search")}
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
      />
      {renderContent()}
      {teamToMove && (
        // Keyed and mounted only while open so each team starts from a fresh form
        <MoveTeamDialog
          key={teamToMove.teamId}
          team={teamToMove}
          organizationId={organizationId}
          open
          onOpenChange={(isOpen) => {
            if (!isOpen) setTeamToMove(null);
          }}
        />
      )}
    </section>
  );
}
