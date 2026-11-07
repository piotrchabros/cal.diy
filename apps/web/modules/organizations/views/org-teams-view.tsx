"use client";

import type { OrganizationRoleDto } from "@calcom/lib/dto/OrganizationDto";
import { useDebounce } from "@calcom/lib/hooks/useDebounce";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import { Badge } from "@calcom/ui/components/badge";
import { Button } from "@calcom/ui/components/button";
import { TextField } from "@calcom/ui/components/form";
import { SkeletonText } from "@calcom/ui/components/skeleton";
import { Table } from "@calcom/ui/components/table";
import { keepPreviousData } from "@tanstack/react-query";
import { useMemo, useState } from "react";

const { Body, Cell, ColumnTitle, Header } = Table;

const FETCH_LIMIT = 20;
const EMPTY_VALUE = "—";

type OrgTeamsViewProps = {
  viewerRole: OrganizationRoleDto;
};

export default function OrgTeamsView({ viewerRole }: OrgTeamsViewProps) {
  const { t } = useLocale();
  const [searchTerm, setSearchTerm] = useState("");
  const debouncedSearchTerm = useDebounce(searchTerm, 300);
  const canManageTeams = viewerRole === "OWNER" || viewerRole === "ADMIN";

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isPending } =
    trpc.viewer.organization.listTeams.useInfiniteQuery(
      { search: debouncedSearchTerm || undefined, limit: FETCH_LIMIT },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        placeholderData: keepPreviousData,
      }
    );

  const teams = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);

  const renderContent = () => {
    if (isPending) {
      return (
        <div className="flex flex-col gap-2" data-testid="org-teams-skeleton">
          <SkeletonText className="h-6 w-full" />
          <SkeletonText className="h-6 w-full" />
          <SkeletonText className="h-6 w-full" />
        </div>
      );
    }
    if (teams.length === 0) {
      return (
        <p className="text-sm text-subtle" data-testid="org-teams-empty">
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
            {canManageTeams && (
              <ColumnTitle widthClassNames="w-auto">
                <span className="sr-only">{t("manage_team")}</span>
              </ColumnTitle>
            )}
          </Header>
          <Body>
            {teams.map((team) => (
              // Table.Row does not forward props, so a plain row carries the test id.
              <tr key={team.teamId} data-testid={`org-team-row-${team.teamId}`}>
                <Cell widthClassNames="w-auto">
                  <div className="flex items-center gap-2">
                    <span className="text-default">{team.name}</span>
                    {team.viewerIsMember && (
                      <Badge variant="blue" data-testid="org-team-member-badge">
                        {t("you_are_a_member")}
                      </Badge>
                    )}
                  </div>
                </Cell>
                <Cell>{team.slug ?? EMPTY_VALUE}</Cell>
                <Cell>{team.memberCount}</Cell>
                {canManageTeams && (
                  <Cell widthClassNames="w-auto">
                    <div className="flex w-full justify-end gap-2">
                      <Button
                        color="secondary"
                        size="sm"
                        href={`/settings/my-teams/${team.teamId}/members`}
                        data-testid="org-team-members-link">
                        {t("members")}
                      </Button>
                      <Button
                        color="secondary"
                        size="sm"
                        href={`/settings/my-teams/${team.teamId}/profile`}
                        data-testid="org-team-manage-link">
                        {t("manage_team")}
                      </Button>
                    </div>
                  </Cell>
                )}
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
    <div className="flex flex-col gap-3">
      <TextField
        name="teamSearch"
        label={t("search")}
        placeholder={t("search")}
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
      />
      {renderContent()}
    </div>
  );
}
