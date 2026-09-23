export function connectCancellationLoader(
	loader: { onAbort?: () => void },
	cancel: () => void,
	done: () => void,
): () => void {
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		done();
	};
	loader.onAbort = () => {
		cancel();
		close();
	};
	return close;
}
