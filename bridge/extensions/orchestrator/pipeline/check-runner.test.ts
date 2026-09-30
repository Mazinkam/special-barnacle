import { describe, expect, test } from "bun:test";
import { runChecks } from "./check-runner.ts";

const node = process.execPath;
const mk = (name: string, code: string) => ({ name, argv: [node, "-e", code], cwd: ".", source: "test" });

describe("runChecks", () => {
	test("pass and fail are reported per check", async () => {
		const r = await runChecks([mk("ok", "process.exit(0)"), mk("bad", "console.error('boom'); process.exit(3)")], process.cwd(), 10_000);
		expect(r.map((x) => [x.name, x.status, x.exitCode])).toEqual([["ok", "pass", 0], ["bad", "fail", 3]]);
		expect(r[1].tail).toContain("boom");
	});
	test("a hanging check times out and is killed", async () => {
		const t0 = Date.now();
		const [r] = await runChecks([mk("hang", "setInterval(() => {}, 1000)")], process.cwd(), 300);
		expect(r.status).toBe("timeout");
		expect(Date.now() - t0).toBeLessThan(8000);
	});
	test("missing binary is an error, not a throw", async () => {
		const [r] = await runChecks([{ name: "nope", argv: ["definitely-not-a-binary-xyz"], cwd: ".", source: "t" }], process.cwd(), 1000);
		expect(r.status).toBe("error");
	});
});
