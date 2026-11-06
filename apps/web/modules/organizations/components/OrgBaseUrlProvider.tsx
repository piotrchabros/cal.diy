"use client";

import {
  OrgBaseUrlContext,
  type OrgBaseUrlContextValue,
} from "@calcom/features/organizations/lib/OrgBaseUrlContext";
import type React from "react";

export function OrgBaseUrlProvider({
  value,
  children,
}: {
  value: OrgBaseUrlContextValue;
  children: React.ReactNode;
}) {
  return <OrgBaseUrlContext.Provider value={value}>{children}</OrgBaseUrlContext.Provider>;
}
