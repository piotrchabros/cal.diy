"use client";

import type { OrganizationMemberDto, OrganizationRoleDto } from "@calcom/lib/dto/OrganizationDto";
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
const SKELETON_ROW_KEYS = ["first", "second", "third"];
const EMPTY_VALUE = "—";

const ROLE_LABEL_KEYS: Record<OrganizationRoleDto, string> = {
  OWNER: "owner",
  ADMIN: "admin",
  MEMBER: "member",
};

export type OrgMembersViewProps = {
  viewerRole: OrganizationRoleDto;
  viewerUserId: number;
};

// The viewer props are part of the contract now so the page does not change when invite/role/remove actions land for admins and owners.
export default function OrgMembersView(_props: OrgMembersViewProps) {
  const { t } = useLocale();
  const [searchTerm, setSearchTerm] = useState("");
  const debouncedSearchTerm = useDebounce(searchTerm, 300);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isPending } =
    trpc.viewer.organization.listMembers.useInfiniteQuery(
      { search: debouncedSearchTerm || undefined, limit: FETCH_LIMIT },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        placeholderData: keepPreviousData,
      }
    );

  const members = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);

  const renderRow = (member: OrganizationMemberDto) => (
    // Table.Row does not forward props, so a plain row carries the test id.
    <tr key={member.userId} data-testid={`org-member-row-${member.userId}`}>
      <Cell widthClassNames="w-auto">
        <span className="text-default">{member.name ?? EMPTY_VALUE}</span>
      </Cell>
      <Cell>{member.email}</Cell>
      <Cell>{member.username ?? EMPTY_VALUE}</Cell>
      <Cell>
        <div className="flex items-center gap-2">
          <Badge variant={member.role === "MEMBER" ? "gray" : "blue"} data-testid="org-member-role-badge">
            {t(ROLE_LABEL_KEYS[member.role])}
          </Badge>
          {!member.accepted && (
            <Badge variant="orange" data-testid="org-member-pending-badge">
              {t("pending")}
            </Badge>
          )}
        </div>
      </Cell>
    </tr>
  );

  const renderContent = () => {
    if (isPending) {
      return (
        <div className="flex flex-col gap-2" data-testid="org-members-loading">
          {SKELETON_ROW_KEYS.map((key) => (
            <SkeletonText key={key} className="h-8 w-full" />
          ))}
        </div>
      );
    }
    if (members.length === 0) {
      return (
        <p className="text-sm text-subtle" data-testid="org-members-empty">
          {t("no_organization_members_found")}
        </p>
      );
    }

    return (
      <>
        <Table>
          <Header>
            <ColumnTitle widthClassNames="w-auto">{t("name")}</ColumnTitle>
            <ColumnTitle>{t("email")}</ColumnTitle>
            <ColumnTitle>{t("username")}</ColumnTitle>
            <ColumnTitle>{t("role")}</ColumnTitle>
          </Header>
          <Body>{members.map(renderRow)}</Body>
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
        label={t("search")}
        placeholder={t("search")}
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
      />
      {renderContent()}
    </div>
  );
}
