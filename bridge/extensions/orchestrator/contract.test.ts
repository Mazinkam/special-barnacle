import { describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import contract from "./contract.json";
import { PYTHON_MAX_BATCH_RECORDS, STREAMS } from "./record-queue.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("contract.json parity", () => {
	test("the bridge copy is the same symlinked file as orchestrator/contract.json", () => {
		const bridgePath = join(HERE, "contract.json");
		const repoRoot = join(HERE, "..", "..", "..");
		const canonicalPath = join(repoRoot, "orchestrator", "contract.json");
		expect(realpathSync(bridgePath)).toBe(realpathSync(canonicalPath));
		expect(JSON.parse(readFileSync(bridgePath, "utf8"))).toEqual(
			JSON.parse(readFileSync(canonicalPath, "utf8")),
		);
	});

	test("record-queue's STREAMS matches contract.streams", () => {
		expect(STREAMS as readonly string[]).toEqual(Object.keys(contract.streams));
	});

	test("record-queue's PYTHON_MAX_BATCH_RECORDS matches contract.batch.max_records", () => {
		expect(PYTHON_MAX_BATCH_RECORDS).toBe(contract.batch.max_records);
		expect(contract.batch.max_records).toBe(500);
	});

	test("never_archive_files includes every stream file and the ingest status file", () => {
		const streamFiles = Object.values(contract.streams);
		for (const file of streamFiles) {
			expect(contract.never_archive_files).toContain(file);
		}
		expect(contract.never_archive_files).toContain(contract.ingest_status_file);
	});

	test("redaction_regex has separate python/ts patterns and a _todo note explaining why", () => {
		expect(contract.redaction_regex.python).not.toBe(contract.redaction_regex.ts);
		expect(typeof contract.redaction_regex._todo).toBe("string");
		expect(contract.redaction_regex._todo.length).toBeGreaterThan(0);
	});

	test("ts redaction regex behaviour: stops at any whitespace, not just space/tab/newline", () => {
		const re = new RegExp(contract.redaction_regex.ts, "g");
		// A non-breaking space (U+00A0) is whitespace under \s but not matched by the python
		// side's `[^ \t\n|]` class, so the two sides are expected to disagree here on purpose.
		const text = "path:\u00A0/Users/alice/proj\u00A0trailing";
		expect(text.replace(re, "<path>")).toBe("path:\u00A0<path>\u00A0trailing");
	});

	test("state_root env vars and default match the documented names", () => {
		expect(contract.state_root.env_vars.python).toBe("CODING_AGENT_ORCHESTRATOR_HOME");
		expect(contract.state_root.env_vars.ts).toBe("HUMAIN_ORCHESTRATOR_STATE_ROOT");
		expect(contract.state_root.default).toBe("~/.local/state/coding-agent-orchestrator");
	});

	test("batch exit codes and statuses are the documented values", () => {
		expect(contract.batch.exit_codes).toEqual({ ok: 0, invalid: 1, append_failed: 2, refresh_failed: 3 });
		expect(contract.batch.statuses.ok).toBe("ok");
		expect(contract.batch.statuses.invalid).toBe("invalid");
		expect(contract.batch.statuses.append_failed).toBe("append_failed");
		expect(contract.batch.statuses.refresh_failed).toBe("refresh_failed");
		expect(contract.batch.statuses.checkpoint_failed).toBe("checkpoint_failed");
		expect(contract.batch.retry_same_ids).toBe("same_ids");
	});

	test("max_record_id_length matches the documented Python limit", () => {
		expect(contract.batch.max_record_id_length).toBe(200);
	});
});
