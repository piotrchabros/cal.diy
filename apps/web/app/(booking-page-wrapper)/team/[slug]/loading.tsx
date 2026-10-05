"use client";

import { SkeletonContainer, SkeletonText } from "@calcom/ui/components/skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <div className="border-subtle bg-default mb-8 rounded-xl border p-5">
        <div className="bg-emphasis h-16 w-16 animate-pulse rounded-full" />
        <SkeletonText className="mt-4 h-6 w-48" />
        <SkeletonText className="mt-2 h-4 w-64" />
      </div>
      <SkeletonContainer>
        <div className="border-subtle flex items-center justify-between gap-3 rounded-md border p-5">
          <div className="flex-1">
            <SkeletonText className="h-4 w-40" />
            <SkeletonText className="mt-2 h-3 w-56" />
          </div>
        </div>
        <div className="border-subtle flex items-center justify-between gap-3 rounded-md border p-5">
          <div className="flex-1">
            <SkeletonText className="h-4 w-32" />
            <SkeletonText className="mt-2 h-3 w-48" />
          </div>
        </div>
      </SkeletonContainer>
    </div>
  );
}
