import type { AgentBrowserAction } from "@calcom/lib/agentBrowser/contract";

export type MeetingAgentSource = "CHAT" | "SPEECH";

export type MeetingAgentLineSource = MeetingAgentSource | "AGENT";

export type MeetingAgentLine = {
  source: MeetingAgentLineSource;
  speakerName: string | null;
  text: string;
  at: Date;
};

export type MeetingAgentRequest = {
  command: string;
  speakerName: string | null;
  source: MeetingAgentSource;
  recentLines: MeetingAgentLine[];
};

// `goto` is excluded because opening a page also shares the browser into the meeting, see `open`.
export type MeetingAgentBrowserCommand = Exclude<AgentBrowserAction, { type: "goto" }>;

export type MeetingAgentBrowserPage = {
  url: string;
  title: string;
  snapshot: string;
  screenshot: { mediaType: "image/jpeg"; base64: string } | null;
};

export interface MeetingAgentBrowserActions {
  open(url: string): Promise<MeetingAgentBrowserPage>;
  perform(command: MeetingAgentBrowserCommand): Promise<MeetingAgentBrowserPage>;
  close(): Promise<void>;
}

export interface MeetingAgentActions {
  sendChatMessage(text: string): Promise<void>;
  startScreenshare(url: string): Promise<void>;
  stopScreenshare(): Promise<void>;
  browser?: MeetingAgentBrowserActions | null;
}

export type MeetingAgentRunOutcome = "COMPLETED" | "REFUSED" | "LOOP_LIMIT" | "FAILED";

export type MeetingAgentRunResult = {
  outcome: MeetingAgentRunOutcome;
  iterations: number;
  chatMessagesSent: number;
};

export interface IMeetingAgent {
  run(request: MeetingAgentRequest, actions: MeetingAgentActions): Promise<MeetingAgentRunResult>;
}
