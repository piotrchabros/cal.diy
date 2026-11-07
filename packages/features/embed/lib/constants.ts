import { EMBED_LIB_URL } from "@calcom/lib/constants";

export const embedLibUrl = EMBED_LIB_URL;
export const getEmbedPreviewHtmlUrl = (baseUrl: string): string => `${baseUrl}/embed/preview.html`;

export function buildEmbedPreviewIframeSrc({
  baseUrl,
  embedType,
  calLink,
  embedLibUrl,
}: {
  baseUrl: string;
  embedType: string;
  calLink: string;
  embedLibUrl: string;
}): string {
  return `${getEmbedPreviewHtmlUrl(baseUrl)}?embedType=${embedType}&calLink=${calLink}&embedLibUrl=${embedLibUrl}&bookerUrl=${baseUrl}`;
}

export const enum EmbedTheme {
  auto = "auto",
  light = "light",
  dark = "dark",
}
