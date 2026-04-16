import { describe, expect, test } from "bun:test";
import type { AgentSession } from "@mariozechner/pi-coding-agent";

import { extractAssistantReply } from "../src/bot.js";

describe("extractAssistantReply", () => {
	test("returns only assistant text from the current turn", () => {
		const messages = [
			{
				role: "user",
				content: "earlier user message",
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "earlier reply" }],
				stopReason: "endTurn",
			},
			{
				role: "user",
				content: "current user message",
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "current assistant reply" }],
				stopReason: "endTurn",
			},
		] as unknown as AgentSession["messages"];

		expect(extractAssistantReply(messages, 2)).toBe("current assistant reply");
	});

	test("ignores aborted assistant messages", () => {
		const messages = [
			{
				role: "user",
				content: "current user message",
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "discarded reply" }],
				stopReason: "aborted",
			},
		] as unknown as AgentSession["messages"];

		expect(extractAssistantReply(messages, 0)).toBe("");
	});
});
