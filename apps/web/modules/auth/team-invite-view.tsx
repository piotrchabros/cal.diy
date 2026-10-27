"use client";

import { validPassword } from "@calcom/features/auth/lib/validPassword";
import { WEBAPP_URL } from "@calcom/lib/constants";
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
};

type FormValues = {
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

function SetPasswordForm({ invite, token }: { invite: TeamInvite; token: string }) {
  const { t } = useLocale();
  const router = useRouter();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [refreshToken, forceRefresh] = useReducer((x) => x + 1, 0);
  const formMethods = useForm<FormValues>({
    defaultValues: { password: "", confirmPassword: "", csrfToken: "" },
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

  const onSubmit = async (values: FormValues) => {
    setErrorMessage(null);
    const res = await fetch("/api/auth/team-invite", {
      method: "POST",
      body: JSON.stringify({ token, password: values.password, csrfToken: values.csrfToken }),
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      forceRefresh();
      setErrorMessage(json.message || t("something_went_wrong"));
      return;
    }

    const callbackUrl = `${WEBAPP_URL}/settings/my-teams/${invite.teamId}/members`;
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
      <p className="text-default text-sm">
        {t("team_invite_set_password_description", { teamName: invite.teamName })}
      </p>
      <TextField label={t("email_address")} type="email" value={invite.email} disabled readOnly />
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
      {errorMessage && <Alert severity="error" title={errorMessage} />}
      <Button type="submit" loading={isSubmitting} className="w-full justify-center">
        {t("team_invite_set_password_submit")}
      </Button>
    </Form>
  );
}

export default function TeamInviteView({ invite, token }: { invite: TeamInvite | null; token: string }) {
  const { t } = useLocale();
  return (
    <AuthContainer
      showLogo
      heading={invite ? t("join_team_name", { teamName: invite.teamName }) : t("join_team")}>
      {invite ? <SetPasswordForm invite={invite} token={token} /> : <InvalidInvite />}
    </AuthContainer>
  );
}
