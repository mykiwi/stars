# Stars web app (SvelteKit 3 proof of concept)

Port of the static app in `../docs` to [SvelteKit](https://svelte.dev/docs/kit) 3
(Svelte 5 runes, Vite 8, `adapter-static`). Same features, same queries, same
stylesheet; the database is still read in the browser with sql.js-httpvfs.
Nothing is wired into the flake or the Pages workflow yet.

```sh
npm install
npm run dev       # http://localhost:5173, serves ../stars.sqlite (STARS_DB=path for another one)
npm run check     # svelte-check
npm run build     # static site in build/, without the database
npm run preview   # serves build/ with the database
npm run build:docs  # static site in ../docs/next, published at /next/ next to the current app
```

- `vite.config.ts` holds the SvelteKit config and a dev/preview middleware that
  serves `db.json` and the database with range requests, like `assemble-site`.
- `src/routes/+page.svelte` is the single page; filters live in the URL
  (`src/lib/filters.ts`), the rest of `src/lib` is one component per view.
- `build/` uses relative paths, so it can be dropped under `/stars/` on Pages
  next to `db.json` and the `.sqlite.gz` file.
