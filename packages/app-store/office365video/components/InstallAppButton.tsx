import { AppOnboardingSteps } from "@calcom/lib/apps/appOnboardingSteps";
import { getAppOnboardingUrl } from "@calcom/lib/apps/getAppOnboardingUrl";
import { useState } from "react";
import { getAppReturnToUrl } from "../../_utils/getAppReturnToUrl";
import useAddAppMutation from "../../_utils/useAddAppMutation";
import type { InstallAppButtonProps } from "../../types";
import AccountDialog from "./AccountDialog";

export default function InstallAppButton(props: InstallAppButtonProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const mutation = useAddAppMutation(null);
  const handleSubmit = () => {
    mutation.mutate({
      type: "office365_video",
      variant: "conferencing",
      slug: "msteams",
      returnTo: getAppReturnToUrl(
        getAppOnboardingUrl({
          slug: "msteams",
          step: AppOnboardingSteps.EVENT_TYPES_STEP,
        })
      ),
    });
  };

  return (
    <>
      {props.render({
        onClick() {
          setIsModalOpen(true);
        },
        disabled: isModalOpen,
      })}
      <AccountDialog open={isModalOpen} onOpenChange={setIsModalOpen} handleSubmit={handleSubmit} />
    </>
  );
}
