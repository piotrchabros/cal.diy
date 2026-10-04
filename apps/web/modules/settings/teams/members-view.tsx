"use client";

import { useEffect, useState } from "react";

import SettingsHeader from "@calcom/features/settings/appDir/SettingsHeader";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { MembershipRole } from "@calcom/prisma/enums";
import type { RouterOutputs } from "@calcom/trpc/react";
import { trpc } from "@calcom/trpc/react";
import { Alert } from "@calcom/ui/components/alert";
import { Avatar } from "@calcom/ui/components/avatar";
import { Badge } from "@calcom/ui/components/badge";
import { Button } from "@calcom/ui/components/button";
import {
  Dropdown,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@calcom/ui/components/dropdown";
import { EmptyScreen } from "@calcom/ui/components/empty-screen";
import { Checkbox } from "@calcom/ui/components/form/checkbox";
import { TextField } from "@calcom/ui/components/form";
import { Icon } from "@calcom/ui/components/icon";
import { Pagination } from "@calcom/ui/components/pagination";
import { SkeletonText } from "@calcom/ui/components/skeleton";
import { showToast } from "@calcom/ui/components/toast";
import { Table } from "@calcom/ui/components/table";
import { Skeleton } from "@coss/ui/components/skeleton";

import InviteMemberDialog from "./invite-member-dialog";
import MemberRowActions from "./member-row-actions";

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
  teamId,
  item,
  selected,
  onToggle,
  showRole,
  showLastActive,
  canManage,
  onChanged,
}: {
  teamId: number;
  item: MemberItem;
  selected: boolean;
  onToggle: () => void;
  showRole: boolean;
  showLastActive: boolean;
  canManage: boolean;
  onChanged: () => void;
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
      {showRole && (
        <Table.Cell>
          <RoleBadges item={item} />
        </Table.Cell>
      )}
      {showLastActive && (
        <Table.Cell>
          <span className="text-sm text-subtle">{lastActive}</span>
        </Table.Cell>
      )}
      <Table.Cell>
        <div className="flex items-center justify-end gap-1">
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
          {canManage && <MemberRowActions teamId={teamId} item={item} onChanged={onChanged} />}
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

type StatusFilter = "all" | "active" | "pending";

const roleFilterLabel = (role: MembershipRole, t: (key: string) => string) => {
  if (role === MembershipRole.OWNER) return t("owner");
  if (role === MembershipRole.ADMIN) return t("admin");
  return t("member");
};

function MembersToolbar({
  searchInput,
  onSearchInputChange,
  roleFilter,
  onToggleRole,
  statusFilter,
  onStatusFilterChange,
  showRole,
  onToggleShowRole,
  showLastActive,
  onToggleShowLastActive,
}: {
  searchInput: string;
  onSearchInputChange: (value: string) => void;
  roleFilter: MembershipRole[];
  onToggleRole: (role: MembershipRole) => void;
  statusFilter: StatusFilter;
  onStatusFilterChange: (status: StatusFilter) => void;
  showRole: boolean;
  onToggleShowRole: () => void;
  showLastActive: boolean;
  onToggleShowLastActive: () => void;
}) {
  const { t } = useLocale();
  const hasActiveFilters = roleFilter.length > 0 || statusFilter !== "all";

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <TextField
        type="search"
        value={searchInput}
        onChange={(e) => onSearchInputChange(e.target.value)}
        placeholder={t("search")}
        addOnLeading={<Icon name="search" className="h-4 w-4 text-subtle" />}
        containerClassName="w-full sm:w-64 *:mb-0"
      />
      <div className="flex items-center gap-2">
        <Dropdown>
          <DropdownMenuTrigger asChild>
            <Button color="secondary" StartIcon="sliders-horizontal">
              {t("display")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>{t("columns")}</DropdownMenuLabel>
            <DropdownMenuCheckboxItem checked={showRole} onCheckedChange={onToggleShowRole}>
              {t("role")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={showLastActive} onCheckedChange={onToggleShowLastActive}>
              {t("last_active")}
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </Dropdown>
        <Dropdown>
          <DropdownMenuTrigger asChild>
            <Button color="secondary" StartIcon="list-filter">
              {t("filter")}
              {hasActiveFilters ? ` (${roleFilter.length + (statusFilter !== "all" ? 1 : 0)})` : ""}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>{t("role")}</DropdownMenuLabel>
            {[MembershipRole.OWNER, MembershipRole.ADMIN, MembershipRole.MEMBER].map((role) => (
              <DropdownMenuCheckboxItem
                key={role}
                checked={roleFilter.includes(role)}
                onCheckedChange={() => onToggleRole(role)}>
                {roleFilterLabel(role, t)}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("status")}</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={statusFilter === "active"}
              onCheckedChange={() =>
                onStatusFilterChange(statusFilter === "active" ? "all" : "active")
              }>
              {t("member_status_active")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={statusFilter === "pending"}
              onCheckedChange={() =>
                onStatusFilterChange(statusFilter === "pending" ? "all" : "pending")
              }>
              {t("pending")}
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </Dropdown>
      </div>
    </div>
  );
}

function MembersView({ teamId, viewerId: _viewerId, canManage, isPendingInvite }: MembersViewProps) {
  const { t } = useLocale();
  const utils = trpc.useUtils();
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<MembershipRole[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [showRole, setShowRole] = useState(true);
  const [showLastActive, setShowLastActive] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const { data, isLoading, isError, refetch } = trpc.viewer.teams.listMembers.useQuery({
    teamId,
    search: search || undefined,
    roles: roleFilter.length > 0 ? roleFilter : undefined,
    accepted: statusFilter === "all" ? undefined : statusFilter === "active",
    page,
    pageSize,
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

  const toggleRole = (role: MembershipRole) => {
    setRoleFilter((prev) => {
      const next = prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role];
      return next;
    });
    setPage(1);
  };

  const changeStatusFilter = (status: StatusFilter) => {
    setStatusFilter(status);
    setPage(1);
  };

  const changePageSize = (size: number) => {
    setPageSize(size);
    setPage(1);
  };

  const hasActiveFilters = roleFilter.length > 0 || statusFilter !== "all" || search !== "";
  const invalidateList = () => utils.viewer.teams.listMembers.invalidate({ teamId });

  return (
    <SettingsHeader
      title={t("team_members")}
      description={t("members_team_description")}
      CTA={
        canManage ? (
          <Button StartIcon="plus" onClick={() => setInviteOpen(true)}>
            {t("add")}
          </Button>
        ) : undefined
      }>
      <div className="space-y-4">
        {isPendingInvite && (
          <PendingInviteBanner
            teamId={teamId}
            onAccepted={() => utils.viewer.teams.listMembers.invalidate({ teamId })}
          />
        )}

        <MembersToolbar
          searchInput={searchInput}
          onSearchInputChange={setSearchInput}
          roleFilter={roleFilter}
          onToggleRole={toggleRole}
          statusFilter={statusFilter}
          onStatusFilterChange={changeStatusFilter}
          showRole={showRole}
          onToggleShowRole={() => setShowRole((v) => !v)}
          showLastActive={showLastActive}
          onToggleShowLastActive={() => setShowLastActive((v) => !v)}
        />

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
            description={hasActiveFilters ? t("no_team_members_for_filter") : t("no_team_members_description")}
          />
        ) : (
          <div className="space-y-4">
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
                  {showRole && <Table.ColumnTitle>{t("role")}</Table.ColumnTitle>}
                  {showLastActive && <Table.ColumnTitle>{t("last_active")}</Table.ColumnTitle>}
                  <Table.ColumnTitle>
                    <span className="sr-only">{t("actions")}</span>
                  </Table.ColumnTitle>
                </Table.Row>
              </Table.Header>
              <Table.Body>
              {data.items.map((item) => (
                <MemberRow
                  key={item.id}
                  teamId={teamId}
                  item={item}
                  selected={selectedIds.has(item.user.id)}
                  onToggle={() => toggleMember(item.user.id)}
                  showRole={showRole}
                  showLastActive={showLastActive}
                  canManage={canManage}
                  onChanged={invalidateList}
                />
              ))}
            </Table.Body>
          </Table>
          <Pagination
            currentPage={page}
            pageSize={pageSize}
            totalItems={data.total}
            onPageChange={setPage}
            onPageSizeChange={changePageSize}
          />
        </div>
        )}
      </div>
      {canManage && (
        <InviteMemberDialog
          teamId={teamId}
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          onInvited={invalidateList}
        />
      )}
    </SettingsHeader>
  );
}

export default MembersView;
export type { MemberItem, MembersViewProps };
