import { ShellMainAppDir } from "app/(use-page-wrapper)/(main-nav)/ShellMainAppDir";
import { SkeletonButton, SkeletonContainer, SkeletonText } from "@calcom/ui/components/skeleton";

export default function Loading() {
  return (
    <ShellMainAppDir heading={<SkeletonText className="h-6 w-24" />} CTA={<SkeletonButton />}>
      <SkeletonContainer>
        <div className="border-subtle flex items-center gap-4 rounded-xl border p-4">
          <div className="bg-emphasis h-10 w-10 shrink-0 animate-pulse rounded-full" />
          <div className="flex-1">
            <SkeletonText className="h-4 w-32" />
            <SkeletonText className="mt-2 h-3 w-48" />
          </div>
        </div>
      </SkeletonContainer>
    </ShellMainAppDir>
  );
}
