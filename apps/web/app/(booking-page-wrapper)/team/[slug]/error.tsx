"use client";

import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Alert } from "@calcom/ui/components/alert";

export default function Error() {
  const { t } = useLocale();
  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <Alert severity="error" title={t("something_went_wrong")} message={t("please_try_again")} />
    </div>
  );
}
