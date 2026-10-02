import { createDbWorker, type WorkerHttpvfs } from 'sql.js-httpvfs';
import wasmUrl from 'sql.js-httpvfs/dist/sql-wasm.wasm?url';
import workerUrl from 'sql.js-httpvfs/dist/sqlite.worker.js?url';

export interface DbInfo {
	url: string;
	size: number;
}

let worker: WorkerHttpvfs;

export async function openDb(): Promise<DbInfo> {
	// VITE_DB_JSON: where db.json lives when the app is not deployed next to it (e.g. `../db.json`).
	const dbJson = new URL(import.meta.env.VITE_DB_JSON ?? 'db.json', location.href);
	const cfg: DbInfo = await (await fetch(dbJson, { cache: 'no-cache' })).json();
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

export function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
	return worker.db.query(sql, params) as Promise<T[]>;
}

export const stats = () => worker.worker.getStats();
