import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";

// The Pi queue preserves local ordering; the lock also excludes other Pi processes.
// Keep the entire read–modify–write inside the callback, never a model request.
export async function withFileLock<T>(file: string, change: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
	return withFileMutationQueue(file, async () => {
		signal?.throwIfAborted();
		await mkdir(dirname(file), { recursive: true, mode: 0o700 });
		const controller = new AbortController();
		const lockSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		const release = await lockfile.lock(file, {
			realpath: false,
			retries: { retries: 40, factor: 1, minTimeout: 50, maxTimeout: 50 },
			onCompromised: (error) => controller.abort(error),
		});
		try {
			lockSignal.throwIfAborted();
			const result = await change(lockSignal);
			lockSignal.throwIfAborted();
			return result;
		} finally {
			// A compromised lock is already released; do not disturb its new owner.
			if (!controller.signal.aborted) await release();
		}
	});
}
