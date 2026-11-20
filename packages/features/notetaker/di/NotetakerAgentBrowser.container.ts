import { createContainer } from "@calcom/features/di/di";
import {
  moduleLoader as agentBrowserModuleLoader,
  type MeetingAgentBrowserService,
} from "./NotetakerAgentBrowser.module";

const agentBrowserContainer = createContainer();

export function getNotetakerAgentBrowser(): MeetingAgentBrowserService | null {
  agentBrowserModuleLoader.loadModule(agentBrowserContainer);

  return agentBrowserContainer.get<MeetingAgentBrowserService | null>(agentBrowserModuleLoader.token);
}
