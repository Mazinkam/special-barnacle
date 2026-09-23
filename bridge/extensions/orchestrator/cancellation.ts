export class RunCancellation {
	private cancelled = false;
	private readonly listeners = new Set<() => void>();
	private readonly cancelledPromise: Promise<never>;
	private rejectCancellation!: (error: Error) => void;

	constructor() {
		this.cancelledPromise = new Promise((_, reject) => {
			this.rejectCancellation = reject;
		});
		// The rejection is consumed by the next raced operation; this prevents
		// an unhandled rejection if cancellation happens between async stages.
		void this.cancelledPromise.catch(() => {});
	}

	get isCancelled(): boolean {
		return this.cancelled;
	}

	cancel(): void {
		if (this.cancelled) return;
		this.cancelled = true;
		this.rejectCancellation(new Error("Orchestration cancelled"));
		for (const listener of this.listeners) listener();
		this.listeners.clear();
	}

	onCancel(listener: () => void): () => void {
		if (this.cancelled) {
			listener();
			return () => {};
		}
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	throwIfCancelled(): void {
		if (this.cancelled) throw new Error("Orchestration cancelled");
	}

	wait(): Promise<never> {
		return this.cancelledPromise;
	}
}
