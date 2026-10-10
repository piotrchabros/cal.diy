"use client";

import { createContext, useContext } from "react";

const NotetakerFeatureContext: React.Context<boolean> = createContext<boolean>(false);

export function NotetakerFeatureProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return <NotetakerFeatureContext.Provider value={enabled}>{children}</NotetakerFeatureContext.Provider>;
}

export function useNotetakerFeatureEnabled(): boolean {
  return useContext(NotetakerFeatureContext);
}
