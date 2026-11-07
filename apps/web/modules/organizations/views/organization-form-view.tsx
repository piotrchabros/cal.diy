"use client";

import type { OrganizationDto } from "@calcom/lib/dto/OrganizationDto";
import { useDebounce } from "@calcom/lib/hooks/useDebounce";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import { Alert } from "@calcom/ui/components/alert";
import { Button } from "@calcom/ui/components/button";
import { Form, Label, Select, TextField } from "@calcom/ui/components/form";
import { showToast } from "@calcom/ui/components/toast";
import { keepPreviousData } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { Controller, useForm } from "react-hook-form";
import { OrganizationTeamsSection } from "../components/OrganizationTeamsSection";

const ORGANIZATIONS_PATH = "/settings/admin/organizations";
const OWNER_SEARCH_LIMIT = 10;

export type OrganizationFormViewProps = { organizationId?: number };

type OwnerOption = { value: number; label: string };

type OrganizationFormValues = {
  name: string;
  slug: string;
  domain: string;
  owner: OwnerOption | null;
};

type UpdateInput = { id: number; name?: string; slug?: string; domain?: string };

function OrganizationBasicFields({
  form,
  domainDisabled,
}: {
  form: UseFormReturn<OrganizationFormValues>;
  domainDisabled: boolean;
}) {
  const { t } = useLocale();

  return (
    <>
      <TextField label={t("name")} required maxLength={100} {...form.register("name")} />
      <TextField
        label={t("slug")}
        required
        maxLength={63}
        hint={t("organization_slug_hint")}
        {...form.register("slug")}
      />
      <TextField
        label={t("domain")}
        required
        maxLength={253}
        placeholder="cal.example.com"
        disabled={domainDisabled}
        hint={domainDisabled ? t("organization_default_domain_locked") : undefined}
        {...form.register("domain")}
      />
    </>
  );
}

function OwnerSelect({
  value,
  onChange,
}: {
  value: OwnerOption | null;
  onChange: (owner: OwnerOption | null) => void;
}) {
  const { t } = useLocale();
  const [searchTerm, setSearchTerm] = useState("");
  const debouncedSearchTerm = useDebounce(searchTerm, 300);

  const { data, isFetching } = trpc.viewer.admin.listPaginated.useQuery(
    { limit: OWNER_SEARCH_LIMIT, searchTerm: debouncedSearchTerm || undefined },
    { placeholderData: keepPreviousData }
  );

  const options: OwnerOption[] = (data?.rows ?? []).map((user) => ({
    value: user.id,
    label: `${user.name ?? user.username ?? user.email} (${user.email})`,
  }));

  return (
    <div>
      <Label htmlFor="organization-owner">{t("owner")}</Label>
      <Select<OwnerOption>
        inputId="organization-owner"
        options={options}
        value={value}
        onChange={(option) => onChange(option ?? null)}
        isLoading={isFetching}
        isClearable
        // Filtering happens server-side; react-select would otherwise hide matches on profile usernames
        filterOption={null}
        onInputChange={(input, meta) => {
          if (meta.action === "input-change") setSearchTerm(input);
        }}
        placeholder={t("organization_owner_search_placeholder")}
      />
    </div>
  );
}

function CreateOrganizationForm() {
  const { t } = useLocale();
  const router = useRouter();
  const utils = trpc.useUtils();

  const form = useForm<OrganizationFormValues>({
    defaultValues: { name: "", slug: "", domain: "", owner: null },
  });

  const mutation = trpc.viewer.admin.organizations.create.useMutation({
    onSuccess: async () => {
      showToast(t("organization_created_successfully"), "success");
      await utils.viewer.admin.organizations.list.invalidate();
      router.push(ORGANIZATIONS_PATH);
    },
    onError: (err) => {
      showToast(err.message, "error");
    },
  });

  const handleSubmit = (values: OrganizationFormValues) => {
    if (!values.owner) return;
    mutation.mutate({
      name: values.name,
      slug: values.slug,
      domain: values.domain,
      owner: { userId: values.owner.value },
    });
  };

  return (
    <Form form={form} className="stack-y-4" handleSubmit={handleSubmit}>
      <OrganizationBasicFields form={form} domainDisabled={false} />
      <Controller
        name="owner"
        control={form.control}
        rules={{ required: t("organization_owner_required") }}
        render={({ field: { value, onChange }, fieldState: { error } }) => (
          <div>
            <OwnerSelect value={value} onChange={onChange} />
            {error?.message && <p className="mt-1 text-error text-sm">{error.message}</p>}
          </div>
        )}
      />
      <Button type="submit" loading={mutation.isPending}>
        {t("create")}
      </Button>
    </Form>
  );
}

function EditOrganizationFormInner({ organization }: { organization: OrganizationDto }) {
  const { t } = useLocale();
  const router = useRouter();
  const utils = trpc.useUtils();

  const defaultValues: OrganizationFormValues = {
    name: organization.name,
    slug: organization.slug ?? "",
    domain: organization.domain ?? "",
    owner: null,
  };

  const form = useForm<OrganizationFormValues>({ defaultValues });

  const mutation = trpc.viewer.admin.organizations.update.useMutation({
    onSuccess: async () => {
      showToast(t("organization_updated_successfully"), "success");
      await Promise.all([
        utils.viewer.admin.organizations.list.invalidate(),
        utils.viewer.admin.organizations.get.invalidate({ id: organization.id }),
      ]);
      router.push(ORGANIZATIONS_PATH);
    },
    onError: (err) => {
      showToast(err.message, "error");
    },
  });

  const domainChanged = form.watch("domain").trim().toLowerCase() !== (organization.domain ?? "");

  const handleSubmit = (values: OrganizationFormValues) => {
    const input: UpdateInput = { id: organization.id };
    if (values.name !== defaultValues.name) input.name = values.name;
    if (values.slug !== defaultValues.slug) input.slug = values.slug;
    if (values.domain !== defaultValues.domain) input.domain = values.domain;
    if (Object.keys(input).length === 1) return;
    mutation.mutate(input);
  };

  return (
    <Form form={form} className="stack-y-4" handleSubmit={handleSubmit}>
      <OrganizationBasicFields form={form} domainDisabled={organization.isDefault} />
      {domainChanged && (
        // Alert hardcodes its own data-testid, so the wrapper carries ours
        <div data-testid="organization-domain-warning">
          <Alert
            severity="warning"
            title={t("organization_domain_change_warning_title")}
            message={t("organization_domain_change_warning")}
          />
        </div>
      )}
      <div>
        <Label>{t("owner")}</Label>
        <ul className="text-default text-sm">
          {organization.owners.map((owner) => (
            <li key={owner.userId}>{`${owner.name ?? owner.email} (${owner.email})`}</li>
          ))}
        </ul>
      </div>
      <Button type="submit" loading={mutation.isPending}>
        {t("save")}
      </Button>
    </Form>
  );
}

function EditOrganizationForm({ organizationId }: { organizationId: number }) {
  const { t } = useLocale();
  const { data, isPending, error } = trpc.viewer.admin.organizations.get.useQuery({ id: organizationId });

  if (isPending) return <p>{t("loading")}</p>;
  if (error) return <p>{error.message}</p>;

  return (
    <>
      <EditOrganizationFormInner key={data.id} organization={data} />
      <OrganizationTeamsSection organizationId={data.id} />
    </>
  );
}

export default function OrganizationFormView({ organizationId }: OrganizationFormViewProps) {
  if (organizationId === undefined) return <CreateOrganizationForm />;
  return <EditOrganizationForm organizationId={organizationId} />;
}
