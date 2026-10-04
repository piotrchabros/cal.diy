"use client";

import SettingsHeader from "@calcom/features/settings/appDir/SettingsHeader";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import {
  SkeletonAvatar,
  SkeletonButton,
  SkeletonContainer,
  SkeletonText,
} from "@calcom/ui/components/skeleton";

export const TeamProfileSkeleton = () => {
  const { t } = useLocale();
  return (
    <SettingsHeader
      title={t("team_profile")}
      description={t("manage_settings_for_your_team_profile")}
      borderInShellHeader={true}>
      <SkeletonContainer>
        <div className="stack-y-6 rounded-b-lg border border-subtle border-t-0 px-4 py-8">
          <div className="flex items-center">
            <SkeletonAvatar className="me-4 mt-0 h-16 w-16 px-4" />
            <SkeletonButton className="h-6 w-32 rounded-md p-5" />
          </div>
          <SkeletonText className="h-8 w-full" />
          <SkeletonText className="h-8 w-full" />
          <SkeletonText className="h-8 w-full" />
          <SkeletonText className="h-24 w-full" />
          <SkeletonText className="h-8 w-full" />

          <SkeletonButton className="mr-6 h-8 w-20 rounded-md p-5" />
        </div>
      </SkeletonContainer>
    </SettingsHeader>
  );
};
