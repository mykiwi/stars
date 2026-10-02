import { untrack } from 'svelte';
import { createDbWorker, type WorkerHttpvfs } from 'sql.js-httpvfs';
import wasmUrl from 'sql.js-httpvfs/dist/sql-wasm.wasm?url';
import workerUrl from 'sql.js-httpvfs/dist/sqlite.worker.js?url';

export interface DbInfo {
	url: string;
	size: number;
}

let worker: WorkerHttpvfs;

/** What the worker is doing: queries in flight, and how much of the database it has read over HTTP. */
export const activity = $state({ pending: 0, fetched: 0, requests: 0, total: 0 });

// The worker reads pages with blocking requests, so its stats can only be read between two queries.
async function track<T>(work: Promise<T>): Promise<T> {
	// Queries start inside effects: counting them must not make those effects depend on the counter.
	untrack(() => activity.pending++);
	try {
		return await work;
	} finally {
		if (--activity.pending === 0) {
			const s = await worker?.worker.getStats();
			if (s) [activity.fetched, activity.requests, activity.total] = [s.totalFetchedBytes, s.totalRequests, s.totalBytes];
		}
	}
}

async function open(): Promise<DbInfo> {
	// VITE_DB_JSON: where db.json lives when the app is not deployed next to it (e.g. `../db.json`).
	const dbJson = new URL(import.meta.env.VITE_DB_JSON ?? 'db.json', location.href);
	const cfg: DbInfo = await (await fetch(dbJson, { cache: 'no-cache' })).json();
	activity.total = cfg.size;
	// Resolved here: the worker would resolve relative URLs against its own location.
	const abs = (url: string, base: URL | string = location.href) => new URL(url, base).href;
	const url = abs(cfg.url, dbJson);
	worker = await createDbWorker(
		[{ from: 'inline', config: { serverMode: 'full', url, requestChunkSize: 16384 } }],
		abs(workerUrl),
		abs(wasmUrl)
	);
	return { ...cfg, url };
}

export const openDb = () => track(open());

export function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
	return track(worker.db.query(sql, params) as Promise<T[]>);
}

export const stats = () => worker.worker.getStats();
