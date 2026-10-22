import type { NotetakerBotProviderDto } from "@calcom/lib/dto/NotetakerStateDto";

/** The URL is presigned and expiring, so callers must hand it straight to the viewer and never store or log it. */
export type NotetakerVideoDownloadResult =
  | { status: "AVAILABLE"; url: string }
  | { status: "PROCESSING" }
  | { status: "UNAVAILABLE" };

export interface INotetakerRecordingMediaGateway {
  getVideoDownload(externalRef: string): Promise<NotetakerVideoDownloadResult>;
}

export interface INotetakerRecordingMediaGatewayResolver {
  forProvider(provider: NotetakerBotProviderDto): INotetakerRecordingMediaGateway | null;
}
