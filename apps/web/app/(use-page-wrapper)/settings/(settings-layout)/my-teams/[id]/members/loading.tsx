import { SkeletonContainer, SkeletonText } from "@calcom/ui/components/skeleton";

export default function Loading() {
  return (
    <SkeletonContainer>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <SkeletonText className="h-7 w-40" />
          <SkeletonText className="mt-2 h-4 w-56" />
        </div>
        <SkeletonText className="h-9 w-20 rounded-md" />
      </div>
      <SkeletonText className="mb-3 h-9 w-64 rounded-md" />
      <div className="space-y-2">
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="flex items-center gap-3 rounded-md border border-subtle p-3">
            <SkeletonText className="h-8 w-8 rounded-full" />
            <div className="flex-1">
              <SkeletonText className="h-4 w-40" />
              <SkeletonText className="mt-1 h-3 w-56" />
            </div>
            <SkeletonText className="h-5 w-16 rounded" />
          </div>
        ))}
      </div>
    </SkeletonContainer>
  );
}
