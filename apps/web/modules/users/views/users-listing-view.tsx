"use client";

import NoSSR from "@calcom/lib/components/NoSSR";
import { UsersTable } from "../components/UsersTable";

export default function UsersListingView({ organizationsEnabled }: { organizationsEnabled: boolean }) {
  return (
    <NoSSR>
      <UsersTable organizationsEnabled={organizationsEnabled} />
    </NoSSR>
  );
}
