import { describe, expect, test } from "bun:test";
import { CI_ID_RE, classifyTimeout, extractCiRefs, isWaitCommand } from "./wait-stall.ts";

function elapsedMs(fn: () => void): number {
	const start = performance.now();
	fn();
	return performance.now() - start;
}

const U25QE4_CMD =
	"for i in $(seq 1 40); do s=$(glab ci get -p 219469 -F json | jq -r .status); echo $s; case $s in success|failed|canceled) break;; esac; sleep 60; done";

describe("core/wait-stall.ts isWaitCommand", () => {
	const positive: Array<[string, string]> = [
		["classic seq/sleep CI poll loop (u25qe4 incident shape)", U25QE4_CMD],
		["for loop with sleep, single line", "for i in $(seq 1 5); do curl -s x; sleep 10; done"],
		["for loop with glab polling and sleep", "for i in $(seq 1 40); do glab ci get -p 219469; sleep 60; done"],
		["until loop with sleep after do", "until x; do sleep 5; done"],
		["while loop with sleep after command separator", "while true; do echo; sleep 30; done"],
		["until loop with sleep", "until curl -sf http://localhost:3000; do sleep 5; done"],
		["while true loop with sleep", "while true; do check_status; sleep 30; done"],
		["multi-line for/sleep loop", "for i in $(seq 1 10); do\n  echo $i\n  sleep 5\ndone"],
		["watch command with flags", "watch -n 5 kubectl get pods"],
		["watch command after pipe", "echo start | watch -n 1 date"],
		["watch command after semicolon", "cd /tmp; watch ls"],
		["glab ci status --live", "glab ci status -p 219469 --live"],
		["gh run watch", "gh run watch 123"],
		["gh pr checks --watch", "gh pr checks --watch"],
	];
	for (const [label, cmd] of positive) {
		test(`wait command: ${label}`, () => {
			expect(isWaitCommand(cmd)).toBe(true);
		});
	}

	const negative: Array<[string, string | undefined]> = [
		["undefined", undefined],
		["empty string", ""],
		["tail with line count", "tail -500 file.log"],
		["single sleep, no loop", "sleep 2"],
		["sleep chained with &&, no loop", "sleep 2 && npm test"],
		["glab ci get, one-shot", "glab ci get -p 219469"],
		["gh run view, one-shot", "gh run view 123"],
		["plain npm test", "npm test"],
		["for loop without sleep", "for f in *.ts; do echo $f; done"],
		["sleep mentioned as echo argument in loop", "for i in 1; do echo sleep; done"],
		["sleep mentioned as grep argument in loop", "while read l; do grep sleep \"$l\"; done < f"],
		["grep for the word watch", "grep -r watch src/"],
		["cat a file named stopwatch.ts", "cat stopwatch.ts"],
		["gh pr checks without --watch", "gh pr checks"],
		["glab ci status without --live", "glab ci status -p 219469"],
		["two fully-closed loops around a bare sleep is not a sleep-in-loop", "for x in a; do echo x; done; sleep 2; for y in b; do echo y; done"],
		["watch mentioned only inside a single-quoted string", "echo 'gh run watch 123'"],
		["glab ci status --live mentioned only inside a double-quoted string", 'echo "glab ci status --live"'],
		["watch mentioned only inside a quoted string, no command position", "echo 'watch this'"],
		["'do' as an argument to echo, not in command position, is not a loop opener", "echo do; sleep 2"],
		["loop keywords as bare arguments to echo, none in command position", "echo for while until do; sleep 1"],
		["'do' inside a quoted string is stripped before tokenizing, not a loop opener", 'git commit -m "do it"; sleep 1'],
		["glab ci status flag gap must not cross a ';' into a later simple command", "glab ci status; echo --live"],
		["gh pr checks flag gap must not cross a ';' into a later simple command", "gh pr checks; echo --watch"],
	];
	for (const [label, cmd] of negative) {
		test(`not a wait command: ${label}`, () => {
			expect(isWaitCommand(cmd)).toBe(false);
		});
	}

	test("glab ci status --live still matches with an id between the subcommand and the flag", () => {
		expect(isWaitCommand("glab ci status -p 1 --live")).toBe(true);
	});

	test("gh pr checks --watch still matches with an id between the subcommand and the flag", () => {
		expect(isWaitCommand("gh pr checks 12 --watch")).toBe(true);
	});

	test("unterminated loop (no trailing done) with sleep is still a wait command", () => {
		expect(isWaitCommand("for i in 1 2; do sleep 5")).toBe(true);
	});

	test("ReDoS regression: 100KB 'for do sleep 1 ' repeat with no done resolves in well under 200ms", () => {
		const hostile = "for do sleep 1 ".repeat(7000);
		expect(hostile.length).toBeGreaterThan(90000);
		const ms = elapsedMs(() => {
			isWaitCommand(hostile);
		});
		expect(ms).toBeLessThan(200);
	});

	test("ReDoS regression: 100KB 'glab ci get ' repeat resolves in well under 200ms", () => {
		const hostile = "glab ci get ".repeat(9000);
		const ms = elapsedMs(() => {
			isWaitCommand(hostile);
		});
		expect(ms).toBeLessThan(200);
	});

	test("ReDoS regression: 100KB 'while ' repeat resolves in well under 200ms", () => {
		const hostile = "while ".repeat(16000);
		const ms = elapsedMs(() => {
			isWaitCommand(hostile);
		});
		expect(ms).toBeLessThan(200);
	});

	const KIB_100 = 100 * 1024;
	const perfPatterns: Array<[string, string]> = [
		["'\\n'.repeat", "\n"],
		["' \\n'.repeat", " \n"],
		["'\\t\\n  '.repeat", "\t\n  "],
		['\'"\\\\\'.repeat', '"\\'],
		['\'"\'.repeat', '"'],
		["\"'\".repeat", "'"],
		["'$('.repeat", "$("],
		["'glab ci status '.repeat", "glab ci status "],
		["'for do '.repeat", "for do "],
	];
	for (const [label, unit] of perfPatterns) {
		test(`perf regression: ${label} at 100KiB resolves in well under 50ms`, () => {
			const hostile = unit.repeat(Math.ceil(KIB_100 / unit.length));
			expect(hostile.length).toBeGreaterThanOrEqual(KIB_100);
			const ms = elapsedMs(() => {
				isWaitCommand(hostile);
			});
			expect(ms).toBeLessThan(50);
		});
	}

	test("scaling regression: doubling the input (16KiB -> 64KiB, quadrupled) does not quadruple the time — linear, not quadratic", () => {
		const unit = '"\\';
		const make = (bytes: number) => unit.repeat(Math.ceil(bytes / unit.length));
		const small = make(16 * 1024);
		const large = make(64 * 1024);

		// Warm up the JIT on this shape before measuring, so the comparison reflects steady-state
		// algorithmic behavior rather than one-time compilation cost.
		isWaitCommand(small);
		isWaitCommand(large);

		const smallMs = elapsedMs(() => {
			isWaitCommand(small);
		});
		const largeMs = elapsedMs(() => {
			isWaitCommand(large);
		});
		expect(largeMs).toBeLessThan(4 * smallMs + 10);
	});
});

describe("core/wait-stall.ts classifyTimeout", () => {
	test("inactivity timeout with bash wait command in flight -> wait_stall", () => {
		expect(
			classifyTimeout({
				timeoutReason: "inactivity",
				toolInFlight: { name: "bash", command: U25QE4_CMD },
			}),
		).toBe("wait_stall");
	});

	test("tool name is case-insensitive (Bash)", () => {
		expect(
			classifyTimeout({
				timeoutReason: "inactivity",
				toolInFlight: { name: "Bash", command: U25QE4_CMD },
			}),
		).toBe("wait_stall");
	});

	test("absolute timeout with the same wait command -> timed_out (absolute ceiling always fires)", () => {
		expect(
			classifyTimeout({
				timeoutReason: "absolute",
				toolInFlight: { name: "bash", command: U25QE4_CMD },
			}),
		).toBe("timed_out");
	});

	test("outcome cancelled -> timed_out regardless of tool in flight", () => {
		expect(
			classifyTimeout({
				outcome: "cancelled",
				timeoutReason: "inactivity",
				toolInFlight: { name: "bash", command: U25QE4_CMD },
			}),
		).toBe("timed_out");
	});

	test("outcome spend_cap -> timed_out", () => {
		expect(
			classifyTimeout({
				outcome: "spend_cap",
				timeoutReason: "inactivity",
				toolInFlight: { name: "bash", command: U25QE4_CMD },
			}),
		).toBe("timed_out");
	});

	test("outcome timed_out explicitly given is still consistent with wait_stall", () => {
		expect(
			classifyTimeout({
				outcome: "timed_out",
				timeoutReason: "inactivity",
				toolInFlight: { name: "bash", command: U25QE4_CMD },
			}),
		).toBe("wait_stall");
	});

	test("no tool in flight -> timed_out", () => {
		expect(classifyTimeout({ timeoutReason: "inactivity" })).toBe("timed_out");
	});

	test("tool in flight is not bash -> timed_out", () => {
		expect(
			classifyTimeout({
				timeoutReason: "inactivity",
				toolInFlight: { name: "write_file", command: U25QE4_CMD },
			}),
		).toBe("timed_out");
	});

	test("bash tool in flight but command is not a wait command -> timed_out", () => {
		expect(
			classifyTimeout({
				timeoutReason: "inactivity",
				toolInFlight: { name: "bash", command: "npm test" },
			}),
		).toBe("timed_out");
	});

	test("no timeoutReason at all -> timed_out", () => {
		expect(classifyTimeout({ toolInFlight: { name: "bash", command: U25QE4_CMD } })).toBe("timed_out");
	});

	test("toolInFlight.waitPattern=true overrides a command that would not otherwise classify as a wait command", () => {
		expect(
			classifyTimeout({
				timeoutReason: "inactivity",
				toolInFlight: { name: "bash", command: "npm test", waitPattern: true },
			}),
		).toBe("wait_stall");
	});

	test("toolInFlight.waitPattern=false does not suppress a genuinely matching command", () => {
		expect(
			classifyTimeout({
				timeoutReason: "inactivity",
				toolInFlight: { name: "bash", command: U25QE4_CMD, waitPattern: false },
			}),
		).toBe("wait_stall");
	});
});

describe("core/wait-stall.ts extractCiRefs", () => {
	test("u25qe4 incident command extracts the gitlab pipeline id", () => {
		expect(extractCiRefs(U25QE4_CMD)).toEqual([{ provider: "gitlab", kind: "pipeline", id: "219469" }]);
	});

	test("glab ci get --pipeline-id long form", () => {
		expect(extractCiRefs("glab ci get --pipeline-id 42")).toEqual([{ provider: "gitlab", kind: "pipeline", id: "42" }]);
	});

	test("glab ci status -p", () => {
		expect(extractCiRefs("glab ci status -p 987 --live")).toEqual([{ provider: "gitlab", kind: "pipeline", id: "987" }]);
	});

	test("glab ci view", () => {
		expect(extractCiRefs("glab ci view 555")).toEqual([{ provider: "gitlab", kind: "pipeline", id: "555" }]);
	});

	test("glab api pipelines path", () => {
		expect(extractCiRefs("glab api projects/1/pipelines/777")).toEqual([{ provider: "gitlab", kind: "pipeline", id: "777" }]);
	});

	test("gh run view", () => {
		expect(extractCiRefs("gh run view 123")).toEqual([{ provider: "github", kind: "run", id: "123" }]);
	});

	test("gh run watch", () => {
		expect(extractCiRefs("gh run watch 456")).toEqual([{ provider: "github", kind: "run", id: "456" }]);
	});

	test("a real shell separator (;) between the id and an injected command is bounded to its own simple command", () => {
		// In real shell grammar `;` always separates statements regardless of
		// adjacent whitespace, so `-p 219469;rm -rf /` is two simple commands:
		// `glab ci get -p 219469` (a legitimate, whole-token id) and `rm -rf /`
		// (unrelated, never executed or otherwise trusted here — extractCiRefs
		// only ever reads text, it never runs anything).
		expect(extractCiRefs("glab ci get -p 219469;rm -rf /")).toEqual([{ provider: "gitlab", kind: "pipeline", id: "219469" }]);
	});

	test("option scanning does not cross into a later simple command", () => {
		expect(extractCiRefs("glab ci get; echo -p 123")).toEqual([]);
	});

	test("option scanning does not cross a pipe into a later simple command", () => {
		expect(extractCiRefs("glab ci get | echo -p 123")).toEqual([]);
	});

	test("rejects a comma-decorated token as an id", () => {
		expect(extractCiRefs("glab ci view 123,")).toEqual([]);
	});

	test("rejects a period-decorated token as an id", () => {
		expect(extractCiRefs("glab ci view 123.")).toEqual([]);
	});

	test("rejects command substitution instead of a literal id", () => {
		expect(extractCiRefs("glab ci get -p $(curl evil)")).toEqual([]);
	});

	test("rejects 13+ digit ids", () => {
		expect(extractCiRefs("glab ci get -p 1234567890123")).toEqual([]);
	});

	test("does not pick up incidental numbers from seq/sleep/tail", () => {
		expect(extractCiRefs("for i in $(seq 1 40); do sleep 60; done; tail -500 x.log")).toEqual([]);
	});

	test("undefined/empty command yields no refs", () => {
		expect(extractCiRefs(undefined)).toEqual([]);
		expect(extractCiRefs("")).toEqual([]);
	});

	test("dedupes repeated references to the same pipeline", () => {
		expect(extractCiRefs("glab ci get -p 219469; glab ci get -p 219469")).toEqual([{ provider: "gitlab", kind: "pipeline", id: "219469" }]);
	});

	test("caps at 20 distinct references", () => {
		const cmd = Array.from({ length: 25 }, (_, i) => `glab ci view ${1000 + i}`).join("; ");
		expect(extractCiRefs(cmd).length).toBe(20);
	});

	test("CI_ID_RE accepts only pure digit tokens up to 12 digits", () => {
		expect(CI_ID_RE.test("219469")).toBe(true);
		expect(CI_ID_RE.test("1234567890123")).toBe(false);
		expect(CI_ID_RE.test("219469;rm")).toBe(false);
		expect(CI_ID_RE.test("")).toBe(false);
	});

	test("perf regression: 100KB 'glab ci get ' repeat with no -p anywhere resolves in well under 50ms", () => {
		const hostile = "glab ci get ".repeat(9000);
		const start = performance.now();
		expect(extractCiRefs(hostile)).toEqual([]);
		expect(performance.now() - start).toBeLessThan(50);
	});
});
