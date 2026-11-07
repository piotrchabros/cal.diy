"use client";

import type { OrganizationListItemDto } from "@calcom/lib/dto/OrganizationDto";
import { useDebounce } from "@calcom/lib/hooks/useDebounce";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import { Badge } from "@calcom/ui/components/badge";
import { Button } from "@calcom/ui/components/button";
import { ConfirmationDialogContent, Dialog } from "@calcom/ui/components/dialog";
import { TextField } from "@calcom/ui/components/form";
import type { ActionType } from "@calcom/ui/components/table";
import { DropdownActions, Table } from "@calcom/ui/components/table";
import { showToast } from "@calcom/ui/components/toast";
import { keepPreviousData } from "@tanstack/react-query";
import { useMemo, useState } from "react";

const { Body, Cell, ColumnTitle, Header } = Table;

const FETCH_LIMIT = 50;
const EMPTY_VALUE = "—";

type OrganizationToDelete = Pick<OrganizationListItemDto, "id" | "name">;

export default function OrganizationsListingView() {
  const { t } = useLocale();
  const utils = trpc.useUtils();
  const [searchTerm, setSearchTerm] = useState("");
  const debouncedSearchTerm = useDebounce(searchTerm, 300);
  const [orgToDelete, setOrgToDelete] = useState<OrganizationToDelete | null>(null);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isPending, isError } =
    trpc.viewer.admin.organizations.list.useInfiniteQuery(
      { search: debouncedSearchTerm || undefined, limit: FETCH_LIMIT },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        placeholderData: keepPreviousData,
        refetchOnWindowFocus: false,
      }
    );

  const deleteMutation = trpc.viewer.admin.organizations.delete.useMutation({
    onSuccess: () => {
      showToast(t("organization_deleted_successfully"), "success");
      utils.viewer.admin.organizations.list.invalidate();
    },
    onError: (err) => {
      showToast(t(err.message), "error");
    },
    onSettled: () => {
      setOrgToDelete(null);
    },
  });

  const organizations = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);

  const buildActions = (org: OrganizationListItemDto): ActionType[] => {
    const actions: ActionType[] = [
      {
        id: "edit",
        label: t("edit"),
        href: `/settings/admin/organizations/${org.id}/edit`,
        icon: "pencil",
      },
    ];
    // The default organization hosts every user without another org, so it must never be deletable.
    if (!org.isDefault) {
      actions.push({
        id: "delete",
        label: t("delete"),
        color: "destructive",
        onClick: () => setOrgToDelete({ id: org.id, name: org.name }),
        icon: "trash",
      });
    }
    return actions;
  };

  const renderContent = () => {
    if (isPending) return <p className="text-sm text-subtle">{t("loading")}</p>;
    if (isError) return <p className="text-error text-sm">{t("something_went_wrong")}</p>;
    if (organizations.length === 0) {
      return (
        <p className="text-sm text-subtle" data-testid="organizations-empty">
          {t("no_organizations")}
        </p>
      );
    }

    return (
      <>
        <Table>
          <Header>
            <ColumnTitle widthClassNames="w-auto">{t("name")}</ColumnTitle>
            <ColumnTitle>{t("slug")}</ColumnTitle>
            <ColumnTitle>{t("domain")}</ColumnTitle>
            <ColumnTitle>{t("members")}</ColumnTitle>
            <ColumnTitle>{t("teams")}</ColumnTitle>
            <ColumnTitle widthClassNames="w-auto">
              <span className="sr-only">{t("edit")}</span>
            </ColumnTitle>
          </Header>
          <Body>
            {organizations.map((org) => (
              // Table.Row does not forward props, so a plain row carries the test id.
              <tr key={org.id} data-testid={`organization-row-${org.id}`}>
                <Cell widthClassNames="w-auto">
                  <div className="flex items-center gap-2">
                    <span className="text-default">{org.name}</span>
                    {org.isDefault && (
                      <Badge variant="blue" data-testid="organization-default-badge">
                        {t("default")}
                      </Badge>
                    )}
                  </div>
                </Cell>
                <Cell>{org.slug ?? EMPTY_VALUE}</Cell>
                <Cell>{org.domain ?? EMPTY_VALUE}</Cell>
                <Cell>{org.memberCount}</Cell>
                <Cell>{org.teamCount}</Cell>
                <Cell widthClassNames="w-auto">
                  <div className="flex w-full justify-end">
                    <DropdownActions actions={buildActions(org)} />
                  </div>
                </Cell>
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
        name="organizationSearch"
        label={t("search")}
        placeholder={t("organizations_search_placeholder")}
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
      />
      {renderContent()}
      <Dialog open={!!orgToDelete} onOpenChange={(open) => (open ? undefined : setOrgToDelete(null))}>
        <ConfirmationDialogContent
          title={t("delete_organization")}
          confirmBtnText={t("delete")}
          cancelBtnText={t("cancel")}
          variety="danger"
          isPending={deleteMutation.isPending}
          onConfirm={() => {
            if (!orgToDelete) return;
            deleteMutation.mutate({ id: orgToDelete.id });
          }}>
          <p>{t("delete_organization_confirmation", { name: orgToDelete?.name })}</p>
        </ConfirmationDialogContent>
      </Dialog>
    </div>
  );
}
