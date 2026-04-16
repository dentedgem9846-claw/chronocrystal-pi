import { describe, expect, test } from "bun:test";

import { DEFAULT_SIMPLEX_PORT, getSimplexPort, parseSimplexPort } from "./config.js";

describe("parseSimplexPort", () => {
	test("parses a valid numeric port", () => {
		expect(parseSimplexPort("5225")).toBe(5225);
	});

	test("rejects malformed numeric strings", () => {
		expect(() => parseSimplexPort("5225abc")).toThrow("Invalid SIMPLEX_PORT");
		expect(() => parseSimplexPort(" 5225")).toThrow("Invalid SIMPLEX_PORT");
		expect(() => parseSimplexPort("52 25")).toThrow("Invalid SIMPLEX_PORT");
	});

	test("rejects out of range values", () => {
		expect(() => parseSimplexPort("0")).toThrow("Invalid SIMPLEX_PORT");
		expect(() => parseSimplexPort("65536")).toThrow("Invalid SIMPLEX_PORT");
	});
});

describe("getSimplexPort", () => {
	test("uses the default port when unset", () => {
		expect(getSimplexPort({})).toBe(DEFAULT_SIMPLEX_PORT);
	});

	test("throws for invalid environment values", () => {
		expect(() => getSimplexPort({ SIMPLEX_PORT: "12x" })).toThrow("Invalid SIMPLEX_PORT");
	});
});
