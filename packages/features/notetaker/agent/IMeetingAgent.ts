export type MeetingAgentSource = "CHAT" | "SPEECH";

export type MeetingAgentLine = {
  source: MeetingAgentSource;
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

export interface MeetingAgentActions {
  sendChatMessage(text: string): Promise<void>;
  startScreenshare(url: string): Promise<void>;
  stopScreenshare(): Promise<void>;
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
