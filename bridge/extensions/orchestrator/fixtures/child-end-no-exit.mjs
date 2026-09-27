// Deterministic local child for the post-end grace tests (A5/N1a): replays
// the trimmed tail of the real s11yls-lead-0 incident's events.jsonl
// (message_end/turn_end stopReason "error" -> agent_end willRetry -> a
// numeric-delayMs auto_retry_start -> entry_appended) and then, instead of
// exiting, stays alive with a `setInterval` until something kills it — the
// exact shape of the hang runSubagentProcess's post-end grace timer must
// detect and reap on its own.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tailPath = fileURLToPath(new URL("./s11yls-lead-0-tail.jsonl", import.meta.url));
const lines = readFileSync(tailPath, "utf8").trim().split("\n");
for (const line of lines) process.stdout.write(`${line}\n`);

// Never exits on its own; the test (or the grace timer under test) must kill it.
setInterval(() => {}, 1000);
