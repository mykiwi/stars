# Stars

Browse, filter and full-text search my GitHub stars — https://mykiwi.github.io/stars/

- `fetch_stars.py` lists starred repositories through `gh api graphql` (name, URL,
  description, languages, topics, license, counts, dates) and their README, and
  writes everything to a SQLite database with an FTS5 index.
- `docs/` is a static app (no bundler) that queries that database directly in the
  browser with [sql.js-httpvfs](https://github.com/phiresky/sql.js-httpvfs): only
  the SQLite pages needed by a query are downloaded, through HTTP range requests.
- A GitHub Action rebuilds the database every day and deploys it to GitHub Pages.
  The latest database is also published as the `stars.sqlite` asset of the
  [`db` release](https://github.com/mykiwi/stars/releases/tag/db); the next run
  starts from it and only refetches languages and README of repositories pushed
  to since (run the workflow manually with `full` to refetch everything).

## Usage

Everything runs through the Nix flake (`gh` must be logged in):

```sh
nix run .#fetch -- stars.sqlite            # fetch stars of the gh user (--user LOGIN for another one)
gh release download db -p stars.sqlite -O old.sqlite
nix run .#fetch -- stars.sqlite --previous old.sqlite   # incremental: reuse unchanged READMEs
nix run .#serve -- stars.sqlite            # browse on http://localhost:8000
nix run .#assemble -- stars.sqlite _site   # static site as deployed on Pages
nix develop                                # shell with gh, python, sqlite, caddy, node
```

Query the database directly:

```sh
sqlite3 stars.sqlite "SELECT full_name, stars FROM repos JOIN search ON search.rowid = repos.id
                      WHERE search MATCH 'sqlite wasm' ORDER BY rank LIMIT 10"
```

## Schema

| table            | content                                                    |
|------------------|------------------------------------------------------------|
| `repos`          | one row per starred repository                             |
| `readmes`        | README path and raw content                                |
| `repo_languages` | languages with byte sizes; `languages` holds their colors  |
| `repo_topics`    | topics                                                     |
| `search`         | FTS5 index over name, description, topics and README       |
| `meta`           | login, fetch date, count                                   |

## Dependencies

Front-end libraries are declared in `package.json`; `nix/site.nix` reads their
URL and integrity from `package-lock.json`. Renovate keeps them, the flake inputs
and the (digest-pinned) GitHub Actions up to date.
