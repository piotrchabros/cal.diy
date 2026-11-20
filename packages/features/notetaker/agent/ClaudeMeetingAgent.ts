import { APIError } from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaMessage,
  MessageCreateParamsNonStreaming as BetaMessageCreateParamsNonStreaming,
  BetaMessageParam,
  BetaToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import { z } from "zod";
import type {
  IMeetingAgent,
  MeetingAgentActions,
  MeetingAgentRequest,
  MeetingAgentRunResult,
} from "./IMeetingAgent";
import {
  buildMeetingAgentSystemPrompt,
  buildMeetingAgentUserPrompt,
  MEETING_AGENT_CLIENT_TOOLS,
  MEETING_AGENT_SERVER_TOOLS,
} from "./meetingAgentPrompt";

export type AnthropicAgentMessagesClient = {
  beta: { messages: { create(params: BetaMessageCreateParamsNonStreaming): Promise<BetaMessage> } };
};

export interface IClaudeMeetingAgentDeps {
  client: AnthropicAgentMessagesClient;
  model: string;
  logger: ISimpleLogger;
}

// Each call may include server-side web search/fetch, so the cap bounds both latency and cost per command.
export const MEETING_AGENT_MAX_ITERATIONS = 6;
export const MEETING_AGENT_MAX_OUTPUT_TOKENS = 2048;

const MAX_SHARE_URL_LENGTH = 2048;

const sendChatMessageInputSchema = z.object({ text: z.string().trim().min(1) });

const shareScreenInputSchema = z.object({
  url: z
    .string()
    .max(MAX_SHARE_URL_LENGTH)
    .refine((value) => URL.canParse(value) && new URL(value).protocol === "https:"),
});

const stopScreenShareInputSchema = z.object({});

type ToolOutcome = { ok: boolean; content: string };

function joinText(content: BetaContentBlock[]): string {
  let text = "";
  for (const block of content) {
    if (block.type === "text") text += block.text;
  }
  return text.trim();
}

export class ClaudeMeetingAgent implements IMeetingAgent {
  constructor(private readonly deps: IClaudeMeetingAgentDeps) {}

  async run(request: MeetingAgentRequest, actions: MeetingAgentActions): Promise<MeetingAgentRunResult> {
    let iterations = 0;
    let chatMessagesSent = 0;

    const executeTool = async (name: string, input: unknown): Promise<ToolOutcome> => {
      try {
        if (name === "send_chat_message") {
          const parsed = sendChatMessageInputSchema.safeParse(input);
          if (!parsed.success)
            return { ok: false, content: "Invalid input: text must be a non-empty string." };
          await actions.sendChatMessage(parsed.data.text);
          chatMessagesSent += 1;
          return { ok: true, content: "Message sent." };
        }
        if (name === "share_screen") {
          const parsed = shareScreenInputSchema.safeParse(input);
          if (!parsed.success) return { ok: false, content: "Invalid input: url must be an https URL." };
          await actions.startScreenshare(parsed.data.url);
          return { ok: true, content: "Screen share started." };
        }
        if (name === "stop_screen_share") {
          const parsed = stopScreenShareInputSchema.safeParse(input);
          if (!parsed.success) return { ok: false, content: "Invalid input." };
          await actions.stopScreenshare();
          return { ok: true, content: "Screen share stopped." };
        }
        return { ok: false, content: "Unknown tool." };
      } catch {
        // The exception text may contain provider internals, so the model only learns that the action failed.
        return { ok: false, content: "The action failed." };
      }
    };

    try {
      const system = buildMeetingAgentSystemPrompt();
      const messages: BetaMessageParam[] = [{ role: "user", content: buildMeetingAgentUserPrompt(request) }];

      while (iterations < MEETING_AGENT_MAX_ITERATIONS) {
        iterations += 1;
        const response = await this.deps.client.beta.messages.create({
          model: this.deps.model,
          max_tokens: MEETING_AGENT_MAX_OUTPUT_TOKENS,
          system,
          tools: [...MEETING_AGENT_CLIENT_TOOLS, ...MEETING_AGENT_SERVER_TOOLS],
          tool_choice: { type: "auto" },
          output_config: { effort: "low" },
          messages,
          // Lets the API retry on its default substitute model when the requested model declines, instead of failing the command.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        });

        // Server tool blocks must be passed back exactly as received for pause_turn and follow-up turns.
        messages.push({ role: "assistant", content: response.content });

        if (response.stop_reason === "refusal") {
          return { outcome: "REFUSED", iterations, chatMessagesSent };
        }
        if (response.stop_reason === "pause_turn") continue;

        if (response.stop_reason === "tool_use") {
          const toolResults: BetaToolResultBlockParam[] = [];
          for (const block of response.content) {
            if (block.type !== "tool_use") continue;
            const outcome = await executeTool(block.name, block.input);
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: outcome.content,
              ...(outcome.ok ? {} : { is_error: true }),
            });
          }
          messages.push({ role: "user", content: toolResults });
          continue;
        }

        const text = joinText(response.content);
        if (chatMessagesSent === 0 && text.length > 0) {
          await actions.sendChatMessage(text);
          chatMessagesSent += 1;
        }
        return { outcome: "COMPLETED", iterations, chatMessagesSent };
      }

      return { outcome: "LOOP_LIMIT", iterations, chatMessagesSent };
    } catch (error) {
      this.deps.logger.error("Meeting agent run failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
        status: error instanceof APIError ? error.status : undefined,
      });
      return { outcome: "FAILED", iterations, chatMessagesSent };
    }
  }
}
