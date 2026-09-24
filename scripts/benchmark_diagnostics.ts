/** Synthetic-only writer/seal/archive measurement. Run: bun scripts/benchmark_diagnostics.ts */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RunDiagnostics } from "../bridge/extensions/orchestrator/run-diagnostics.ts";

const root = mkdtempSync(join(tmpdir(), "orch-diagnostics-benchmark-"));
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const line = JSON.stringify({ type: "message_end", content: "synthetic diagnostic data ".repeat(400) }) + "\n";
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
try {
	for (const scale of [1, 2, 4]) {
		const baseline: number[] = [], owned: number[] = [], seals: number[] = [];
		let finalRun = "";
		for (let sample = 0; sample < 3; sample++) {
			const count = 100 * scale;
			const rawDir = join(root, `baseline-${scale}-${sample}`);
			mkdirSync(rawDir);
			let start = performance.now();
			for (let i = 0; i < count; i++) appendFileSync(join(rawDir, "task.events.jsonl"), line);
			baseline.push(performance.now() - start);
			const id = `owned-${scale}-${sample}`;
			finalRun = join(root, "runs", id);
			const diagnostics = new RunDiagnostics(finalRun, id);
			const writer = diagnostics.writer();
			start = performance.now();
			for (let i = 0; i < count; i++) {
				if (!writer.append("task.events.jsonl", line)) throw new Error("diagnostic write failed");
			}
			owned.push(performance.now() - start);
			writer.write("task.stderr.log", "synthetic stderr\n");
			writer.write("task.prompt.md", "synthetic prompt\n");
			writer.close();
			start = performance.now();
			if (!await diagnostics.seal(Promise.resolve(true))) throw new Error("seal failed");
			seals.push(performance.now() - start);
		}
		const measurement = JSON.parse(execFileSync("python3", ["-B", "-c", `
import json, sys, time
from pathlib import Path
from datetime import datetime, timedelta, timezone
from orchestrator.archive import archive_runs, restore_run
run=Path(sys.argv[1]); root=run.parent.parent; now=datetime.now(timezone.utc)
(root/'outcomes.jsonl').write_text(json.dumps({'run_id':run.name,'task_id':'run-complete','ts':now.isoformat()})+'\\n')
originals={p.name:p.read_bytes() for p in run.iterdir() if not p.name.startswith('.')}
start=time.perf_counter()
entry=next(e for e in archive_runs(root,execute=True,now=now+timedelta(days=40)) if e['run_id']==run.name)
archive_ms=(time.perf_counter()-start)*1000
assert entry['status']=='archived',entry
assert restore_run(root,run.name)['status']=='restored'
assert all((run/n).read_bytes()==data for n,data in originals.items())
print(json.dumps({k:entry[k] for k in ('raw_bytes_removed','compressed_bytes','reclaimed_bytes','storage_delta_bytes')} | {'archive_ms':archive_ms,'round_trip_equal':True}))
`, finalRun], { env: { ...process.env, PYTHONPATH: repo, PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8" }));
		console.log(JSON.stringify({ scale, samples: 3, event_bytes: Buffer.byteLength(line) * 100 * scale,
			baseline_write_ms: median(baseline), owned_write_ms: median(owned), seal_ms: median(seals), ...measurement }));
	}
} finally { rmSync(root, { recursive: true, force: true }); }
