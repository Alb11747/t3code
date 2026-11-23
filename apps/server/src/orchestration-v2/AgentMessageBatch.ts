import {
  type OrchestrationV2ConversationMessage,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  withMessageSenderNote,
} from "@t3tools/contracts";
import type { AgentMessageOffer } from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { hasClaudeSkillMention } from "../provider/Drivers/ClaudeSkillDispatch.ts";

export function ordinaryAgentReportText(
  message: Pick<
    OrchestrationV2ConversationMessage,
    "createdBy" | "creationSource" | "senderThreadId" | "linkedSender" | "attachments" | "text"
  >,
): string | undefined {
  if (
    message.createdBy !== "agent" ||
    message.creationSource !== "mcp" ||
    (message.senderThreadId === undefined && message.linkedSender === undefined) ||
    message.attachments.length !== 0 ||
    hasClaudeSkillMention(message.text)
  )
    return undefined;
  const text = withMessageSenderNote(message, message.text);
  // Commands and skill invocations must stay at the start of their own prompt.
  return text === message.text ? undefined : text;
}

export function groupAgentReportOffers(offers: ReadonlyArray<AgentMessageOffer>) {
  const groups: Array<{
    readonly lead: AgentMessageOffer;
    readonly offers: Array<AgentMessageOffer>;
    report: string | undefined;
  }> = [];
  for (const offer of offers) {
    const report = offer.batchable === true ? ordinaryAgentReportText(offer) : undefined;
    const prior = groups.at(-1);
    if (
      prior?.report !== undefined &&
      report !== undefined &&
      prior.report.length + 2 + report.length <= PROVIDER_SEND_TURN_MAX_INPUT_CHARS
    ) {
      prior.offers.push(offer);
      prior.report += `\n\n${report}`;
    } else {
      groups.push({ lead: offer, offers: [offer], report });
    }
  }
  return groups;
}
