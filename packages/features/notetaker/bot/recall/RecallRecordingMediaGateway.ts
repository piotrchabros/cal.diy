import { ErrorWithCode } from "@calcom/lib/errors";
import type {
  INotetakerRecordingMediaGateway,
  NotetakerVideoDownloadResult,
} from "../INotetakerRecordingMediaGateway";
import type { IRecallApiClient } from "./RecallApiClient";
import { getRecallApiErrorInfo } from "./RecallApiClient";
import { sortRecallRecordingsByStartedAt } from "./recallEventTranslation";
import type { RecallBot } from "./recallSchemas";

const PROCESSING: NotetakerVideoDownloadResult = { status: "PROCESSING" };
const UNAVAILABLE: NotetakerVideoDownloadResult = { status: "UNAVAILABLE" };

function toVideoDownload(bot: RecallBot): NotetakerVideoDownloadResult {
  const [recording] = sortRecallRecordingsByStartedAt(bot.recordings);
  if (!recording) return UNAVAILABLE;

  const shortcut = recording.media_shortcuts?.video_mixed;
  if (shortcut) {
    const url = shortcut.data?.download_url;
    switch (shortcut.status?.code) {
      case "done":
        // Only https URLs are handed out so a malformed or hostile value can never become a link.
        return url?.startsWith("https://") ? { status: "AVAILABLE", url } : UNAVAILABLE;
      case "processing":
        return PROCESSING;
      default:
        return UNAVAILABLE;
    }
  }
  return recording.status?.code === "processing" ? PROCESSING : UNAVAILABLE;
}

export class RecallRecordingMediaGateway implements INotetakerRecordingMediaGateway {
  private readonly client: IRecallApiClient;

  constructor(deps: { client: IRecallApiClient }) {
    this.client = deps.client;
  }

  async getVideoDownload(externalRef: string): Promise<NotetakerVideoDownloadResult> {
    let bot: RecallBot | null;
    try {
      bot = await this.client.retrieveBot(externalRef);
    } catch (error) {
      const info = getRecallApiErrorInfo(error);
      if (!info) throw error;
      const status = info.status === null ? "" : ` (status ${info.status})`;
      throw ErrorWithCode.Factory.InternalServerError(`Recall video lookup failed: ${info.kind}${status}`);
    }
    return bot ? toVideoDownload(bot) : UNAVAILABLE;
  }
}
