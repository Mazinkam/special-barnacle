/** Fresh-directory, single-owner diagnostics. No raw descriptor escapes this module.
 * Child producers retain leases until stdio `close`, NOT early timeout/error settlement.
 * Closing rejects new producers; existing leases have a bounded drain before fsync/hash/durable seal.
 * Drain timeout, crash, failed write or failed terminal acknowledgement leaves the run unsealed.
 */
import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync, closeSync, constants, existsSync, fstatSync, fsyncSync, ftruncateSync, linkSync, lstatSync,
	mkdirSync, openSync, readSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const OWNER_FILE = ".diagnostics-owner.json";
export const SEAL_FILE = ".diagnostics-sealed.json";
const PROTOCOL = "ht-run-diagnostics-v1";
const SEAL_DRAIN_TIMEOUT_MS = 2000;
const owners = new Map<string, RunDiagnostics>();
const protectedNames = new Set([
	"events.jsonl", "metrics.jsonl", "outcomes.jsonl", "discoveries.jsonl", "ledger.json",
	"ledger.lock", "records.checkpoint.json", "records.index.sqlite3", "ingest_status.json",
	"archive.manifest.json", "archive.lock",
]);

function syncDirectory(dir: string): void {
	const fd = openSync(dir, constants.O_RDONLY | constants.O_NOFOLLOW);
	try { fsyncSync(fd); } finally { closeSync(fd); }
}

function publish(dir: string, name: string, value: unknown): void {
	const tmp = join(dir, `.${name}.${randomUUID()}.tmp`);
	const fd = openSync(tmp, "wx", 0o600);
	try {
		try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
		linkSync(tmp, join(dir, name)); // no clobber, including a seal from another owner
		syncDirectory(dir);
	} finally { unlinkSync(tmp); }
}

export interface DiagnosticWriter {
	write(name: string, text: string): boolean;
	append(name: string, text: string): boolean;
	close(): void;
}

export class RunDiagnostics {
	private readonly owner;
	private readonly files = new Map<string, { dev: number; ino: number }>();
	private readonly leases = new Set<symbol>();
	private accepting = true;
	private failed = false;
	private drained: (() => void) | undefined;
	private sealing: Promise<boolean> | undefined;

	constructor(readonly dir: string, runId: string) {
		if (basename(dir) !== runId || runId.startsWith(".") || /[/\\\0]/.test(runId)) throw new Error("invalid run id");
		mkdirSync(dirname(dir), { recursive: true });
		// Existing directories (even empty ones) can have legacy open descriptors. Never adopt them.
		for (const p of [dirname(dir), dirname(dirname(dir))]) {
			if (!lstatSync(p).isDirectory()) throw new Error(`unsafe diagnostic directory: ${p}`);
		}
		mkdirSync(dir, { mode: 0o700 });
		this.owner = { format_version: 1, protocol: PROTOCOL, run_id: runId, owner_id: randomUUID() };
		publish(dir, OWNER_FILE, this.owner);
		syncDirectory(dirname(dir));
		owners.set(resolve(dir), this);
	}

	write(name: string, text: string, append = false): boolean {
		return this.accepting && this.writeOwned(name, text, append);
	}

	writer(): DiagnosticWriter {
		if (!this.accepting) throw new Error("diagnostics are closing/sealed; no new writer allowed");
		const lease = Symbol();
		this.leases.add(lease);
		return {
			write: (name, text) => this.leases.has(lease) && this.writeOwned(name, text, false),
			append: (name, text) => this.leases.has(lease) && this.writeOwned(name, text, true),
			close: () => {
				this.leases.delete(lease);
				if (this.leases.size === 0) this.drained?.();
			},
		};
	}

	private writeOwned(name: string, text: string, append: boolean): boolean {
		try {
			if (!name || basename(name) !== name || /[/\\\0]/.test(name) || name.startsWith(".") || name.endsWith(".gz") || protectedNames.has(name)) {
				throw new Error(`unsafe diagnostic name: ${name}`);
			}
			const previous = this.files.get(name);
			const fd = openSync(join(this.dir, name), constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK |
				(previous ? 0 : constants.O_CREAT | constants.O_EXCL) | (append ? constants.O_APPEND : 0), 0o600);
			try {
				const st = fstatSync(fd);
				if (!st.isFile() || st.nlink !== 1 || (previous && (previous.ino !== st.ino || previous.dev !== st.dev))) throw new Error("diagnostic inode changed");
				// writeFileSync(fd) does not truncate; truncate only after validating the owned inode.
				if (!append) ftruncateSync(fd);
				writeFileSync(fd, text);
				this.files.set(name, { dev: st.dev, ino: st.ino });
			} finally { closeSync(fd); }
			return true;
		} catch (error) {
			this.failed = true;
			console.warn(`[orchestrator] diagnostic write failed; run will not seal: ${String(error)}`);
			return false;
		}
	}

	seal(terminal: Promise<boolean>): Promise<boolean> {
		// A shutdown timeout may veto a seal already waiting for producer close. Do not
		// discard that negative acknowledgement merely because the attempt is memoized.
		void terminal.then(ok => { if (!ok) this.failed = true; }, () => { this.failed = true; });
		if (this.sealing) return this.sealing;
		this.accepting = false;
		this.sealing = (async () => {
			// A detached descendant can keep inherited stdio open indefinitely. Bound the
			// wait, not the producer lifetime: on expiry leases may still append, but this
			// memoized seal attempt stays false even if every producer closes later.
			let timer: ReturnType<typeof setTimeout> | undefined;
			let acknowledged: boolean;
			try {
				const writers = new Promise<void>(done => { this.drained = done; if (!this.leases.size) done(); });
				acknowledged = await Promise.race([
					Promise.all([terminal, writers]).then(([ok]) => ok),
					new Promise<boolean>(done => { timer = setTimeout(() => done(false), SEAL_DRAIN_TIMEOUT_MS); }),
				]);
			} finally {
				if (timer !== undefined) clearTimeout(timer);
				this.drained = undefined;
			}
			if (!acknowledged || this.failed) return false;
			const files: Record<string, { sha256: string; raw_bytes: number }> = {};
			const buffer = Buffer.alloc(1024 * 1024);
			for (const [name, identity] of this.files) {
				const fd = openSync(join(this.dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
				try {
					const st = fstatSync(fd);
					if (!st.isFile() || st.nlink !== 1 || st.dev !== identity.dev || st.ino !== identity.ino) throw new Error("diagnostic inode changed before seal");
					fsyncSync(fd);
					const hash = createHash("sha256");
					let raw_bytes = 0, n: number;
					while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) { hash.update(buffer.subarray(0, n)); raw_bytes += n; }
					files[name] = { sha256: hash.digest("hex"), raw_bytes };
				} finally { closeSync(fd); }
			}
			publish(this.dir, SEAL_FILE, { ...this.owner, sealed_at: new Date().toISOString(), files });
			return true;
		})().catch(error => {
			console.warn(`[orchestrator] diagnostics not sealed: ${String(error)}`);
			return false;
		}).finally(() => { owners.delete(resolve(this.dir)); });
		return this.sealing;
	}
}

// This legacy exported path helper cannot bypass an owning session, even after reload/sealing.
export function appendDiagnosticPath(path: string, text: string): boolean {
	const dir = resolve(dirname(path));
	const owner = owners.get(dir);
	if (owner) return owner.write(basename(path), text, true);
	if (existsSync(join(dir, OWNER_FILE)) || existsSync(join(dir, SEAL_FILE))) return false;
	appendFileSync(path, text);
	return true;
}
