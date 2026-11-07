"use client";

import NoSSR from "@calcom/lib/components/NoSSR";
import { AdminTeamsTable } from "../components/AdminTeamsTable";

export default function AdminTeamsListingView() {
  return (
    <NoSSR>
      <AdminTeamsTable />
    </NoSSR>
  );
}
