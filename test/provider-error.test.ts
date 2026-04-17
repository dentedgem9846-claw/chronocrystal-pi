import { describe, expect, test } from "bun:test";

import { formatProviderErrorForUser } from "../src/provider-error.js";

describe("formatProviderErrorForUser", () => {
	test("formats rate limit errors with retry-after guidance", () => {
		const reply = formatProviderErrorForUser(
			{
				message: "429 Too Many Requests",
				status: 429,
				headers: new Headers({ "retry-after": "30" }),
			},
			"github-copilot/gpt-4.1"
		);

		expect(reply).toContain("Provider error from github-copilot/gpt-4.1: rate limited this request.");
		expect(reply).toContain("Retry after about 30s.");
	});

	test("formats quota and billing failures", () => {
		const reply = formatProviderErrorForUser(
			{
				status: 402,
				error: {
					type: "billing_error",
					message: "Insufficient credits remaining",
				},
			},
			"github-copilot/gpt-4.1"
		);

		expect(reply).toContain("the account appears out of quota or credits");
		expect(reply).toContain("Details: Insufficient credits remaining");
	});

	test("formats authentication failures", () => {
		const reply = formatProviderErrorForUser(
			new Error("No API key for provider: github-copilot"),
			"github-copilot/gpt-4.1"
		);

		expect(reply).toContain("authentication or permissions failed");
	});

	test("formats network failures", () => {
		const reply = formatProviderErrorForUser(
			new Error("Network error: connect ECONNRESET api.githubcopilot.com"),
			"github-copilot/gpt-4.1"
		);

		expect(reply).toContain("connection to the provider failed");
	});

	test("returns null for unrelated internal errors", () => {
		const reply = formatProviderErrorForUser(new Error("Unexpected undefined value in local parser"), "github-copilot/gpt-4.1");
		expect(reply).toBeNull();
	});
});
