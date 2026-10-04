"use client";

import { useState } from "react";

import SettingsHeader from "@calcom/features/settings/appDir/SettingsHeader";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { MembershipRole } from "@calcom/prisma/enums";
import type { RouterOutputs } from "@calcom/trpc/react";
import { trpc } from "@calcom/trpc/react";
import { Alert } from "@calcom/ui/components/alert";
import { Avatar } from "@calcom/ui/components/avatar";
import { Badge } from "@calcom/ui/components/badge";
import { Button } from "@calcom/ui/components/button";
import { EmptyScreen } from "@calcom/ui/components/empty-screen";
import { Checkbox } from "@calcom/ui/components/form/checkbox";
import { SkeletonText } from "@calcom/ui/components/skeleton";
import { showToast } from "@calcom/ui/components/toast";
import { Table } from "@calcom/ui/components/table";
import { Skeleton } from "@coss/ui/components/skeleton";

type ListMembersOutput = RouterOutputs["viewer"]["teams"]["listMembers"];
type MemberItem = ListMembersOutput["items"][number];

type MembersViewProps = {
  teamId: number;
  viewerId: number;
  canManage: boolean;
  isPendingInvite: boolean;
};

const roleBadgeVariant = (role: MembershipRole) => {
  if (role === MembershipRole.OWNER) return "blue" as const;
  if (role === MembershipRole.ADMIN) return "blue" as const;
  return "gray" as const;
};

function RoleBadges({ item }: { item: MemberItem }) {
  const { t } = useLocale();
  return (
    <div className="flex flex-col items-start gap-1">
      {!item.accepted && <Badge variant="orange">{t("pending")}</Badge>}
      <Badge variant={roleBadgeVariant(item.role)}>
        {item.role === MembershipRole.OWNER
          ? t("owner")
          : item.role === MembershipRole.ADMIN
          ? t("admin")
          : t("member")}
      </Badge>
    </div>
  );
}

function MemberRow({
  item,
  selected,
  onToggle,
}: {
  item: MemberItem;
  selected: boolean;
  onToggle: () => void;
}) {
  const { t } = useLocale();
  const displayName = item.user.name || item.user.email;
  const initial = displayName.charAt(0).toUpperCase();
  const lastActive = item.user.lastActiveAt
    ? new Date(item.user.lastActiveAt).toLocaleDateString()
    : "–";

  return (
    <Table.Row>
      <Table.Cell widthClassNames="w-10">
        <Checkbox checked={selected} onCheckedChange={onToggle} aria-label={t("select_member")} />
      </Table.Cell>
      <Table.Cell>
        <div className="flex items-center gap-3">
          <Avatar
            size="md"
            alt={displayName}
            imageSrc={item.user.avatarUrl}
            fallback={initial}
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-emphasis">{displayName}</p>
            <p className="truncate text-sm text-subtle">{item.user.email}</p>
          </div>
        </div>
      </Table.Cell>
      <Table.Cell>
        <RoleBadges item={item} />
      </Table.Cell>
      <Table.Cell>
        <span className="text-sm text-subtle">{lastActive}</span>
      </Table.Cell>
      <Table.Cell>
        <div className="flex justify-end">
          {item.user.username ? (
            <Button
              variant="icon"
              color="minimal"
              size="sm"
              href={`/${item.user.username}`}
              target="_blank"
              StartIcon="external-link"
              aria-label={t("open_member_profile")}>
              <span className="sr-only">{t("open_member_profile")}</span>
            </Button>
          ) : null}
        </div>
      </Table.Cell>
    </Table.Row>
  );
}

function MembersTableSkeleton() {
  return (
    <div className="space-y-2" aria-label="loading">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex items-center gap-3 rounded-md border border-subtle p-3">
          <Skeleton className="h-8 w-8 rounded-full" />
          <div className="flex-1">
            <SkeletonText className="h-4 w-40" />
            <SkeletonText className="mt-1 h-3 w-56" />
          </div>
          <Skeleton className="h-5 w-16 rounded" />
        </div>
      ))}
    </div>
  );
}

function PendingInviteBanner({
  teamId,
  onAccepted,
}: {
  teamId: number;
  onAccepted: () => void;
}) {
  const { t } = useLocale();
  const acceptInviteMutation = trpc.viewer.teams.acceptInvite.useMutation({
    onSuccess: async () => {
      showToast(t("invitation_accepted"), "success");
      onAccepted();
    },
    onError: (error) => {
      showToast(error.message, "error");
    },
  });

  return (
    <Alert
      severity="info"
      title={t("pending_team_invitation_title")}
      message={t("pending_team_invitation_description")}
      actions={
        <Button
          size="sm"
          loading={acceptInviteMutation.isPending}
          onClick={() => acceptInviteMutation.mutate({ teamId })}>
          {t("accept_invitation")}
        </Button>
      }
    />
  );
}

function MembersView({ teamId, viewerId: _viewerId, canManage: _canManage, isPendingInvite }: MembersViewProps) {
  const { t } = useLocale();
  const utils = trpc.useUtils();
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const { data, isLoading, isError, refetch } = trpc.viewer.teams.listMembers.useQuery({
    teamId,
    page: 1,
    pageSize: 10,
  });

  const toggleMember = (userId: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  };

  const toggleAll = (items: MemberItem[]) => {
    setSelectedIds((prev) => {
      if (items.every((item) => prev.has(item.user.id))) {
        return new Set();
      }
      return new Set(items.map((item) => item.user.id));
    });
  };

  return (
    <SettingsHeader title={t("team_members")} description={t("members_team_description")}>
      <div className="space-y-4">
        {isPendingInvite && (
          <PendingInviteBanner
            teamId={teamId}
            onAccepted={() => utils.viewer.teams.listMembers.invalidate({ teamId })}
          />
        )}

        {isLoading ? (
          <MembersTableSkeleton />
        ) : isError ? (
          <EmptyScreen
            Icon="x"
            headline={t("team_members_load_error")}
            description={t("team_members_load_error_description")}
            buttonText={t("retry")}
            buttonOnClick={() => refetch()}
          />
        ) : !data || data.items.length === 0 ? (
          <EmptyScreen
            Icon="users"
            headline={t("no_team_members")}
            description={t("no_team_members_description")}
          />
        ) : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.ColumnTitle widthClassNames="w-10">
                  <Checkbox
                    checked={data.items.every((item) => selectedIds.has(item.user.id))}
                    onCheckedChange={() => toggleAll(data.items)}
                    aria-label={t("select_all_members")}
                  />
                </Table.ColumnTitle>
                <Table.ColumnTitle>{t("member")}</Table.ColumnTitle>
                <Table.ColumnTitle>{t("role")}</Table.ColumnTitle>
                <Table.ColumnTitle>{t("last_active")}</Table.ColumnTitle>
                <Table.ColumnTitle>
                  <span className="sr-only">{t("actions")}</span>
                </Table.ColumnTitle>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.items.map((item) => (
                <MemberRow
                  key={item.id}
                  item={item}
                  selected={selectedIds.has(item.user.id)}
                  onToggle={() => toggleMember(item.user.id)}
                />
              ))}
            </Table.Body>
          </Table>
        )}
      </div>
    </SettingsHeader>
  );
}

export default MembersView;
export type { MemberItem, MembersViewProps };
