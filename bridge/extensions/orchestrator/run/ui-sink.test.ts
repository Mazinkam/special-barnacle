import { describe, expect, test } from "bun:test";
import { safeUi } from "./ui-sink.ts";

describe("safeUi", () => {
	test("runs the function and returns normally when it does not throw", () => {
		let ran = false;
		safeUi(() => { ran = true; });
		expect(ran).toBe(true);
	});

	test("swallows a throw instead of propagating it", () => {
		expect(() => safeUi(() => { throw new Error("ctx.ui unavailable"); })).not.toThrow();
	});
});
