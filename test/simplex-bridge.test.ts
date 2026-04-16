import { describe, expect, test } from "bun:test";
import type { T } from "@simplex-chat/types";

import { extractReceivedText } from "../src/simplex-bridge.js";

describe("extractReceivedText", () => {
	test("returns text for received direct text messages", () => {
		const chatItem = {
			content: {
				type: "rcvMsgContent",
				msgContent: {
					type: "text",
					text: "hello",
				},
			},
		} as T.ChatItem;

		expect(extractReceivedText(chatItem)).toBe("hello");
	});

	test("returns null for malformed text payloads", () => {
		const chatItem = {
			content: {
				type: "rcvMsgContent",
				msgContent: {
					type: "text",
					text: 42,
				},
			},
		} as unknown as T.ChatItem;

		expect(extractReceivedText(chatItem)).toBeNull();
	});

	test("returns null for non-text payloads", () => {
		const chatItem = {
			content: {
				type: "rcvMsgContent",
				msgContent: {
					type: "image",
					text: "caption",
				},
			},
		} as unknown as T.ChatItem;

		expect(extractReceivedText(chatItem)).toBeNull();
	});

	test("returns null for sent messages", () => {
		const chatItem = {
			content: {
				type: "sndMsgContent",
				msgContent: {
					type: "text",
					text: "echo",
				},
			},
		} as unknown as T.ChatItem;

		expect(extractReceivedText(chatItem)).toBeNull();
	});
});
