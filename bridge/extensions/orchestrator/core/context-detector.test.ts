import { describe, expect, test } from "bun:test";
import { goalRefersToMissingContext, SHORT_GOAL_MAX_CHARS } from "./context-detector.ts";

describe("core/context-detector.ts goalRefersToMissingContext", () => {
	const positives: Array<[string, string]> = [
		["do A then C then B", "sequence of standalone capital letters"],
		["implement option 2", "option N phrase"],
		["go with the above", "the above phrase"],
		["as discussed, ship the fix", "as discussed phrase"],
		["run that plan now", "that plan phrase"],
		["add a README for part B", "conservative: standalone letter B is still a reference"],
	];
	for (const [goal, why] of positives) {
		test(`flags: "${goal}" (${why})`, () => {
			expect(goalRefersToMissingContext(goal)).toBe(true);
		});
	}

	const negatives: Array<[string, string]> = [
		["fix the login race condition in the auth module", "plain, self-contained goal"],
		["fix the API error handling for the checkout flow", "API is not a standalone letter"],
		["I think the retry logic has a bug, please fix it", "lone I is the pronoun, not a reference"],
		["add a health check endpoint", "lone lowercase a is an article, not a reference"],
		[
			`do A then C then B.${"z".repeat(SHORT_GOAL_MAX_CHARS - "do A then C then B.".length)}`,
			"long goal is exempt regardless of content",
		],
		["", "empty goal"],
	];
	for (const [goal, why] of negatives) {
		test(`does not flag: ${why}`, () => {
			expect(goalRefersToMissingContext(goal)).toBe(false);
		});
	}

	test("boundary: a goal exactly at the max length is not short", () => {
		const base = "the above";
		const goal = `${base} ${"x".repeat(SHORT_GOAL_MAX_CHARS - base.length - 1)}`;
		expect(goal.length).toBe(SHORT_GOAL_MAX_CHARS);
		expect(goalRefersToMissingContext(goal)).toBe(false);
	});

	test("boundary: one character under the max length is still checked", () => {
		const base = "the above";
		const goal = `${base} ${"x".repeat(SHORT_GOAL_MAX_CHARS - base.length - 2)}`;
		expect(goal.length).toBe(SHORT_GOAL_MAX_CHARS - 1);
		expect(goalRefersToMissingContext(goal)).toBe(true);
	});
});
