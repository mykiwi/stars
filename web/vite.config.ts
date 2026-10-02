import { createReadStream, statSync } from 'node:fs';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Connect, type Plugin } from 'vite';

// Dev/preview only: serve the database like `assemble-site` lays it out (db.json + range requests).
function starsDb(file = process.env.STARS_DB ?? '../stars.sqlite'): Plugin {
	const name = 'stars-dev.sqlite.gz';
	const middleware: Connect.NextHandleFunction = (req, res, next) => {
		const path = req.url?.split('?')[0];
		if (path !== '/db.json' && path !== `/${name}`) return next();
		let size: number;
		try {
			size = statSync(file).size;
		} catch {
			res.statusCode = 404;
			return res.end(`${file} not found (set STARS_DB)`);
		}
		if (path === '/db.json') {
			res.setHeader('content-type', 'application/json');
			return res.end(JSON.stringify({ url: name, size }));
		}
		const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
		const start = range ? Number(range[1]) : 0;
		const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
		res.statusCode = range ? 206 : 200;
		res.setHeader('content-type', 'application/gzip');
		res.setHeader('accept-ranges', 'bytes');
		res.setHeader('content-length', end - start + 1);
		if (range) res.setHeader('content-range', `bytes ${start}-${end}/${size}`);
		if (req.method === 'HEAD') return res.end();
		createReadStream(file, { start, end }).pipe(res);
	};
	return {
		name: 'stars-db',
		configureServer: (server) => void server.middlewares.use(middleware),
		configurePreviewServer: (server) => void server.middlewares.use(middleware)
	};
}

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// STARS_OUT: build somewhere else, e.g. into ../docs/next to publish it next to the current app.
			adapter: adapter({ pages: process.env.STARS_OUT ?? 'build' })
		}),
		starsDb()
	]
});
