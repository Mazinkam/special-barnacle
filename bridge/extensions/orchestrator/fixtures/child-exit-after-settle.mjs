// Deterministic local child used by index.test.ts to prove that a child which
// completes the JSON protocol (message_end -> agent_end -> agent_settled) and
// THEN exits non-zero has its result recovered as `completed_after_process_error`,
// not silently failed.
const events = [
	{
		type: "message_end",
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "fixture task completed" }],
		},
	},
	{ type: "agent_end", messages: [] },
	{ type: "agent_settled" },
];

for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
process.stderr.write("fixture shutdown failure\n");
process.exitCode = 1;
