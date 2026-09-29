import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { DiscoveredCheck } from "../core/check-discovery.ts";

export interface CheckRunResult { name: string; argv: string[]; status: "pass" | "fail" | "timeout" | "error"; exitCode: number | null; durationMs: number; tail: string }
const TAIL = 4000;

function runOne(check: DiscoveredCheck, repoRoot: string, timeoutMs: number): Promise<CheckRunResult> {
	const started = Date.now();
	return new Promise((resolveResult) => {
		let out = "";
		let timedOut = false;
		let settled = false;
		let child: ChildProcess;
		let timer: ReturnType<typeof setTimeout>;
		const finish = (status: CheckRunResult["status"], exitCode: number | null) => {
			if (settled) return;
			settled = true;
			resolveResult({ name: check.name, argv: check.argv, status, exitCode, durationMs: Date.now() - started, tail: out.slice(-TAIL) });
		};
		try {
			child = spawn(check.argv[0], check.argv.slice(1), { cwd: join(repoRoot, check.cwd), shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
		} catch (err) {
			out = String(err); finish("error", null); return;
		}
		const append = (b: Buffer) => { out = (out + b.toString("utf8")).slice(-TAIL * 2); };
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		const killGroup = (sig: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, sig); } catch { /* already gone */ } };
		timer = setTimeout(() => { timedOut = true; killGroup("SIGTERM"); setTimeout(() => killGroup("SIGKILL"), 5000).unref(); }, timeoutMs);
		child.on("error", (err) => { clearTimeout(timer); out += String(err); finish("error", null); });
		child.on("close", (code) => { clearTimeout(timer); finish(timedOut ? "timeout" : code === 0 ? "pass" : "fail", code); });
	});
}

export async function runChecks(checks: DiscoveredCheck[], repoRoot: string, timeoutMs: number, cancellation?: { isCancelled: boolean }): Promise<CheckRunResult[]> {
	const results: CheckRunResult[] = [];
	for (const c of checks) {
		if (cancellation?.isCancelled) break;
		results.push(await runOne(c, repoRoot, timeoutMs));
	}
	return results;
}
