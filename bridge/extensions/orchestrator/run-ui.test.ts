import { describe, expect, mock, test } from "bun:test";
import { connectCancellationLoader } from "./run-ui.ts";

describe("orchestration cancellation UI", () => {
	test("Esc requests cancellation and closes the loader exactly once", () => {
		const loader: { onAbort?: () => void } = {};
		const cancel = mock();
		const done = mock();
		const close = connectCancellationLoader(loader, cancel, done);

		loader.onAbort?.();

		expect(cancel).toHaveBeenCalledTimes(1);
		expect(done).toHaveBeenCalledTimes(1);
		close();
		expect(done).toHaveBeenCalledTimes(1);
	});
});
