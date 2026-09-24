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

function assertSafeDiagnosticName(name: string): void {
	if (!name || basename(name) !== name || /[/\\\0]/.test(name) || name.startsWith(".") || name.endsWith(".gz") || protectedNames.has(name)) {
		throw new Error(`unsafe diagnostic name: ${name}`);
	}
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

/**
 * A raw, real file descriptor for a child process's stdio slot (e.g.
 * `stdio[2]`), created/owned under the same fresh-directory, single-owner
 * guarantees as every other diagnostic file. Node's async pipe reads can
 * silently drop the tail of a fast-exiting child's stderr (see index.ts's
 * runSubagentProcess); handing the child a real fd instead avoids that
 * entirely, at the cost of the caller managing the fd's lifetime explicitly.
 */
export interface ChildStderrFile {
	readonly path: string;
	readonly fd: number;
	/** Close the caller's copy of the fd. Idempotent. Call once the child has
	 * inherited it (or spawning failed) — the child's own duplicate, if any,
	 * keeps the file writable independently of this call. */
	closeFd(): void;
	/** Release the write lease taken for this file, closing the fd first if the
	 * caller has not already done so. Call once no further diagnostic writes
	 * (raw child bytes or `writer()` appends) will target this file. */
	release(): void;
}

export class RunDiagnostics {
	private readonly owner;
	private readonly files = new Map<string, { dev: number; ino: number }>();
	/**
	 * Recorded once, at `openChildStderrFile(...).release()` time, for a
	 * child-stderr file only: the fstat size/mtime the orchestrator itself last
	 * observed after every write it intended to make. A detached descendant
	 * that escaped the process group (see index.ts's `killProcessTree`) can
	 * still hold the same underlying open file description and keep writing
	 * after that point; `seal()` compares against this snapshot and vetoes the
	 * seal if the file no longer matches, the way the old pipe path effectively
	 * did when a holder kept the pipe open.
	 */
	private readonly childStderrFinal = new Map<string, { size: number; mtimeMs: number }>();
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

	/**
	 * Open/create `name` for a child process to write directly (e.g. as
	 * `stdio[2]`), under a lease like `writer()`. The returned fd is registered
	 * as this file's owned identity so later `writer().write/append(name, ...)`
	 * calls (used to append the orchestrator's own notes once the child has
	 * exited) pass the same inode-unchanged validation as any other diagnostic
	 * write, instead of bypassing it.
	 */
	openChildStderrFile(name: string): ChildStderrFile {
		if (!this.accepting) throw new Error("diagnostics are closing/sealed; no new writer allowed");
		assertSafeDiagnosticName(name);
		if (this.files.has(name)) throw new Error(`diagnostic file already exists: ${name}`);
		const path = join(this.dir, name);
		// O_APPEND matters beyond this process's own writes: a detached descendant
		// that escaped the process group (its own dup of this same fd, inherited
		// through fork/exec) can keep writing after we believe the run is done.
		// Without O_APPEND its writes land at that fd's own (possibly stale, e.g.
		// still 0) offset, which can overwrite bytes a *different* fd (ours, in
		// writeOwned below) wrote later at that same offset. With O_APPEND every
		// write through this open file description — including the descendant's —
		// atomically targets the current end of file, so it can only ever append.
		const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_APPEND, 0o600);
		try {
			const st = fstatSync(fd);
			if (!st.isFile() || st.nlink !== 1) throw new Error("diagnostic inode changed");
			this.files.set(name, { dev: st.dev, ino: st.ino });
		} catch (error) {
			closeSync(fd);
			throw error;
		}
		const lease = Symbol();
		this.leases.add(lease);
		let fdOpen = true;
		const closeFd = () => {
			if (!fdOpen) return;
			fdOpen = false;
			closeSync(fd);
		};
		return {
			path,
			fd,
			closeFd,
			release: () => {
				closeFd();
				// Snapshot the file's current state as "the orchestrator's final,
				// intended write" — release() is documented as being called once no
				// further diagnostic writes (raw child bytes or writer() appends)
				// will target this file. Any later change (a still-writing escaped
				// descendant) is caught by seal()'s comparison against this snapshot.
				try {
					const identity = this.files.get(name);
					if (identity) {
						const rfd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
						try {
							const st = fstatSync(rfd);
							if (st.isFile() && st.nlink === 1 && st.dev === identity.dev && st.ino === identity.ino) {
								this.childStderrFinal.set(name, { size: st.size, mtimeMs: st.mtimeMs });
							}
						} finally { closeSync(rfd); }
					}
				} catch {
					/* seal() independently re-validates and fails closed if unreadable */
				}
				this.leases.delete(lease);
				if (this.leases.size === 0) this.drained?.();
			},
		};
	}

	private writeOwned(name: string, text: string, append: boolean): boolean {
		try {
			assertSafeDiagnosticName(name);
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
					// A child-stderr file only: if it grew/changed after the orchestrator's
					// own last intended write (recorded at openChildStderrFile(...).release()),
					// an escaped descendant is still writing through the inherited fd. Veto
					// the seal rather than sha256/publish a file we cannot vouch for.
					const finalSnapshot = this.childStderrFinal.get(name);
					if (finalSnapshot && (st.size !== finalSnapshot.size || st.mtimeMs !== finalSnapshot.mtimeMs)) {
						throw new Error(`child stderr file changed after the orchestrator's final write; seal vetoed: ${name}`);
					}
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
