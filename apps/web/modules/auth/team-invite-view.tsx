"use client";

import { validPassword } from "@calcom/features/auth/lib/validPassword";
import { useOrgBaseUrl } from "@calcom/features/organizations/lib/OrgBaseUrlContext";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Alert } from "@calcom/ui/components/alert";
import { Button } from "@calcom/ui/components/button";
import { Form, PasswordField, TextField } from "@calcom/ui/components/form";
import AuthContainer from "@components/ui/AuthContainer";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { useEffect, useReducer, useState } from "react";
import { useForm } from "react-hook-form";

type TeamInvite = {
  teamId: number;
  teamName: string;
  email: string;
  isOrganization: boolean;
  needsPassword: boolean;
  needsUsername: boolean;
};

type FormValues = {
  username: string;
  password: string;
  confirmPassword: string;
  csrfToken: string;
};

function InvalidInvite() {
  const { t } = useLocale();
  return (
    <div className="stack-y-6">
      <p className="text-default text-center">{t("team_invite_link_invalid")}</p>
      <Button href="/auth/login" className="w-full justify-center">
        {t("login")}
      </Button>
    </div>
  );
}

function getFormCopyKeys(invite: TeamInvite): { description: string; submit: string } {
  if (invite.needsUsername && invite.needsPassword) {
    return { description: "team_invite_complete_account_description", submit: "team_invite_complete_submit" };
  }
  if (invite.needsUsername) {
    return { description: "team_invite_choose_username_description", submit: "team_invite_complete_submit" };
  }
  return { description: "team_invite_set_password_description", submit: "team_invite_set_password_submit" };
}

function CompleteInviteForm({
  invite,
  token,
  landingPath,
}: {
  invite: TeamInvite;
  token: string;
  landingPath: string;
}) {
  const { t } = useLocale();
  const router = useRouter();
  const orgBaseUrl = useOrgBaseUrl();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [refreshToken, forceRefresh] = useReducer((x) => x + 1, 0);
  const formMethods = useForm<FormValues>({
    defaultValues: { username: "", password: "", confirmPassword: "", csrfToken: "" },
  });
  const {
    register,
    setValue,
    getValues,
    formState: { isSubmitting, errors },
  } = formMethods;

  useEffect(() => {
    fetch("/api/csrf", { cache: "no-store" })
      .then((res) => res.json())
      .then(({ csrfToken }) => setValue("csrfToken", csrfToken))
      .catch(() => setValue("csrfToken", ""));
  }, [setValue, refreshToken]);

  const copyKeys = getFormCopyKeys(invite);

  const onSubmit = async (values: FormValues) => {
    setErrorMessage(null);
    const res = await fetch("/api/auth/team-invite", {
      method: "POST",
      body: JSON.stringify({
        token,
        csrfToken: values.csrfToken,
        ...(invite.needsPassword && { password: values.password }),
        ...(invite.needsUsername && { username: values.username }),
      }),
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      forceRefresh();
      setErrorMessage(
        json.message === "username_taken_in_organization"
          ? t("username_taken_in_organization")
          : json.message || t("something_went_wrong")
      );
      return;
    }

    const callbackUrl = `${orgBaseUrl}${landingPath}`;
    if (!invite.needsPassword) {
      // The invitee already has a password, so they finish by logging in with it.
      const loginParams = new URLSearchParams({ email: invite.email, callbackUrl });
      router.push(`/auth/login?${loginParams.toString()}`);
      return;
    }
    const signInResult = await signIn<"credentials">("credentials", {
      email: invite.email,
      password: values.password,
      callbackUrl,
      redirect: false,
    });
    if (!signInResult || signInResult.error) {
      // The password is already set, so the regular login page is the way forward.
      const loginParams = new URLSearchParams({ email: invite.email, callbackUrl });
      router.push(`/auth/login?${loginParams.toString()}`);
      return;
    }
    router.push(callbackUrl);
  };

  return (
    <Form className="stack-y-6" form={formMethods} handleSubmit={onSubmit}>
      <input {...register("csrfToken")} type="hidden" hidden />
      <p className="text-default text-sm">{t(copyKeys.description, { teamName: invite.teamName })}</p>
      <TextField label={t("email_address")} type="email" value={invite.email} disabled readOnly />
      {invite.needsUsername && (
        <>
          <TextField
            label={t("username")}
            autoComplete="username"
            {...register("username", {
              validate: (value) => value.trim().length > 0 || t("team_invite_username_required"),
            })}
          />
          {errors.username?.message && <p className="text-error text-sm">{errors.username.message}</p>}
        </>
      )}
      {invite.needsPassword && (
        <>
          <PasswordField
            label={t("password")}
            autoComplete="new-password"
            {...register("password", {
              validate: (value) => validPassword(value) || t("invalid_password_hint", { passwordLength: 7 }),
            })}
          />
          {errors.password?.message && <p className="text-error text-sm">{errors.password.message}</p>}
          <PasswordField
            label={t("confirm_password")}
            autoComplete="new-password"
            {...register("confirmPassword", {
              validate: (value) => value === getValues("password") || t("passwords_do_not_match"),
            })}
          />
          {errors.confirmPassword?.message && (
            <p className="text-error text-sm">{errors.confirmPassword.message}</p>
          )}
        </>
      )}
      {errorMessage && <Alert severity="error" title={errorMessage} />}
      <Button type="submit" loading={isSubmitting} className="w-full justify-center">
        {t(copyKeys.submit)}
      </Button>
    </Form>
  );
}

export default function TeamInviteView({
  invite,
  token,
  landingPath,
}: {
  invite: TeamInvite | null;
  token: string;
  landingPath: string;
}) {
  const { t } = useLocale();
  return (
    <AuthContainer
      showLogo
      heading={invite ? t("join_team_name", { teamName: invite.teamName }) : t("join_team")}>
      {invite ? (
        <CompleteInviteForm invite={invite} token={token} landingPath={landingPath} />
      ) : (
        <InvalidInvite />
      )}
    </AuthContainer>
  );
}
