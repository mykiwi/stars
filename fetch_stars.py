"""Fetch a GitHub user's starred repositories into a SQLite database.

Uses the `gh` CLI for authentication (local `gh auth login` or GH_TOKEN in CI).
The resulting database is laid out for sql.js-httpvfs: small pages, no WAL,
vacuumed, with an FTS5 index over name, description, topics and README.
"""

import argparse
import base64
import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

README_CANDIDATES = ["README.md", "readme.md", "Readme.md", "README.rst", "README", "README.markdown"]

DETAILS_QUERY = """
query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Repository {
      id
      languages(first: 30, orderBy: {field: SIZE, direction: DESC}) { edges { size node { name color } } }
      %s
    }
  }
}
""" % "\n      ".join(
    f'r{i}: object(expression: "HEAD:{name}") {{ ... on Blob {{ text isBinary isTruncated }} }}'
    for i, name in enumerate(README_CANDIDATES)
)

SCHEMA = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
-- id is the rank by star date (1 = most recent) so the default listing reads contiguous pages.
CREATE TABLE repos (
  id INTEGER PRIMARY KEY,
  github_id INTEGER NOT NULL UNIQUE,
  full_name TEXT NOT NULL UNIQUE,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  homepage TEXT,
  language TEXT,
  languages TEXT NOT NULL,
  topics TEXT NOT NULL,
  license TEXT,
  stars INTEGER NOT NULL,
  forks INTEGER NOT NULL,
  archived INTEGER NOT NULL,
  fork INTEGER NOT NULL,
  created_at TEXT,
  pushed_at TEXT,
  starred_at TEXT NOT NULL,
  readme_size INTEGER NOT NULL
);
CREATE INDEX repos_starred_at ON repos (starred_at);
CREATE INDEX repos_stars ON repos (stars);
CREATE INDEX repos_pushed_at ON repos (pushed_at);
CREATE INDEX repos_language ON repos (language);
CREATE TABLE languages (name TEXT PRIMARY KEY, color TEXT) WITHOUT ROWID;
CREATE TABLE repo_languages (
  language TEXT NOT NULL,
  repo_id INTEGER NOT NULL REFERENCES repos (id),
  bytes INTEGER NOT NULL,
  PRIMARY KEY (language, repo_id)
) WITHOUT ROWID;
CREATE TABLE repo_topics (
  topic TEXT NOT NULL,
  repo_id INTEGER NOT NULL REFERENCES repos (id),
  PRIMARY KEY (topic, repo_id)
) WITHOUT ROWID;
CREATE TABLE readmes (
  repo_id INTEGER PRIMARY KEY REFERENCES repos (id),
  path TEXT NOT NULL,
  content TEXT NOT NULL
);
-- Precomputed filter counts, so the app does not scan whole tables on load.
CREATE TABLE facets (
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (kind, count, name)
) WITHOUT ROWID;
-- Star count over time: JSON [[days since 1970-01-01, stars], ...], downsampled (see downsample()).
-- backfilled is the date the star-history.com backfill was attempted (NULL = never).
CREATE TABLE star_history (
  repo_id INTEGER PRIMARY KEY REFERENCES repos (id),
  points TEXT NOT NULL,
  backfilled TEXT
);
CREATE VIEW search_source AS
  SELECT r.id, r.full_name, r.description, r.topics, m.content AS readme
  FROM repos r LEFT JOIN readmes m ON m.repo_id = r.id;
CREATE VIRTUAL TABLE search USING fts5 (
  full_name, description, topics, readme,
  content = 'search_source', content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);
"""


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


class RateLimiter:
    """Shared across threads: pause everyone when GitHub says we are (nearly) out of quota."""

    LOW_WATERMARK = 20

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.resume_at = 0.0

    def wait(self) -> None:
        with self.lock:
            delay = self.resume_at - time.time()
        if delay > 0:
            time.sleep(delay)

    def pause_until(self, at: float, reason: str) -> None:
        with self.lock:
            if at <= self.resume_at:
                return
            self.resume_at = at
        log(f"  {reason}: pausing {at - time.time():.0f}s")

    def observe(self, status: int, headers: dict[str, str], body: str) -> bool:
        """Record rate limit headers; return True if the request was rate limited and must be retried."""
        remaining = headers.get("x-ratelimit-remaining")
        reset = float(headers.get("x-ratelimit-reset", time.time() + 60)) + 1
        if status in (403, 429):
            if "retry-after" in headers:
                self.pause_until(time.time() + int(headers["retry-after"]) + 1, "secondary rate limit")
                return True
            if remaining == "0":
                self.pause_until(reset, "rate limit exhausted")
                return True
            if "rate limit" in body.lower():
                self.pause_until(time.time() + 60, "secondary rate limit")
                return True
        if remaining is not None and int(remaining) < self.LOW_WATERMARK:
            self.pause_until(reset, f"only {remaining} {headers.get('x-ratelimit-resource', '')} requests left")
        return False


RATE = RateLimiter()


def gh_api(*args: str, body: str | None = None) -> tuple[int, dict[str, str], str]:
    """Call `gh api -i`, honouring rate limit headers. Returns (HTTP status, headers, body)."""
    for _ in range(10):
        RATE.wait()
        proc = subprocess.run(["gh", "api", "-i", *args], input=body, capture_output=True, text=True)
        head, _, payload = proc.stdout.replace("\r\n", "\n").partition("\n\n")
        lines = head.splitlines()
        if not lines or not lines[0].startswith("HTTP/"):
            log(f"  gh api {args[0]} failed: {proc.stderr.strip()[:300]}")
            return 0, {}, ""
        status = int(lines[0].split()[1])
        headers = {k.strip().lower(): v.strip() for k, _, v in (line.partition(":") for line in lines[1:])}
        if not RATE.observe(status, headers, payload):
            return status, headers, payload
    return 429, {}, ""


def graphql(query: str, variables: dict) -> dict | None:
    """Run a GraphQL query; return None on errors (typically timeouts on heavy queries)."""
    status, _, payload = gh_api("graphql", "--input", "-", body=json.dumps({"query": query, "variables": variables}))
    if status == 200:
        data = json.loads(payload)
        if not data.get("errors"):
            return data["data"]
        log(f"  graphql error: {json.dumps(data['errors'])[:300]}")
    else:
        log(f"  graphql HTTP {status}: {payload[:200]}")
    return None


def starred_page(login: str, page: int) -> tuple[list[dict], int]:
    """One page of stars (REST pages can be fetched in parallel, unlike GraphQL cursors)."""
    path = f"users/{login}/starred?per_page=100&page={page}"
    for attempt in range(6):
        status, headers, payload = gh_api(path, "-H", "Accept: application/vnd.github.star+json")
        if status == 200:
            last = re.search(r'[?&]page=(\d+)>; rel="last"', headers.get("link", ""))
            return json.loads(payload), int(last.group(1)) if last else page
        if status == 404:
            raise SystemExit(f"unknown GitHub user: {login}")
        time.sleep(2**attempt)
    raise SystemExit(f"listing stars page {page} kept failing (HTTP {status})")


def normalize(star: dict) -> dict:
    r = star["repo"]
    lic = r.get("license")
    return {
        "id": r["id"],
        "node_id": r["node_id"],
        "full_name": r["full_name"],
        "owner": r["owner"]["login"],
        "name": r["name"],
        "url": r["html_url"],
        "description": r["description"],
        "homepage": r["homepage"] or None,
        "language": r["language"],
        "topics": r.get("topics") or [],
        "license": lic and (lic["spdx_id"] if lic["spdx_id"] not in (None, "NOASSERTION") else lic["name"]),
        "stars": r["stargazers_count"],
        "forks": r["forks_count"],
        "archived": int(r["archived"]),
        "fork": int(r["fork"]),
        "created_at": r["created_at"],
        "pushed_at": r["pushed_at"],
        "starred_at": star["starred_at"],
        "size": r["size"],
    }


def fetch_stars(login: str, jobs: int, max_pages: int | None) -> list[dict]:
    first, last = starred_page(login, 1)
    if max_pages:
        last = min(last, max_pages)
    stars = list(first)
    with ThreadPoolExecutor(jobs) as pool:
        for page, (items, _) in enumerate(pool.map(lambda p: starred_page(login, p), range(2, last + 1)), 2):
            stars += items
            if page % 10 == 0 or page == last:
                log(f"  {page}/{last} pages")
    repos: dict[int, dict] = {}
    for star in stars:
        repo = normalize(star)
        repos.setdefault(repo["id"], repo)
    return sorted(repos.values(), key=lambda r: r["starred_at"], reverse=True)


def fetch_details(ids: list[str], attempt: int = 0) -> list[dict]:
    """Languages and README blobs for repo node ids, splitting the batch when GitHub times out."""
    data = graphql(DETAILS_QUERY, {"ids": ids})
    if data is not None:
        return [n for n in data["nodes"] if n]
    if len(ids) > 1:
        mid = len(ids) // 2
        return fetch_details(ids[:mid]) + fetch_details(ids[mid:])
    if attempt < 3:
        time.sleep(2 ** (attempt + 1))
        return fetch_details(ids, attempt + 1)
    log(f"  giving up on details for {ids[0]}")
    return []


def readme_from_graphql(node: dict) -> tuple[str, str] | None:
    for i, name in enumerate(README_CANDIDATES):
        blob = node.get(f"r{i}")
        if blob and not blob["isBinary"] and not blob["isTruncated"] and blob["text"] is not None:
            return name, blob["text"]
    return None


def readme_from_rest(full_name: str) -> tuple[str, str] | None:
    """Fallback handling any README name/location (docs/, .github/, other extensions)."""
    for attempt in range(4):
        status, _, payload = gh_api(f"repos/{full_name}/readme")
        if status == 200:
            data = json.loads(payload)
            if data.get("encoding") != "base64":
                return None
            return data["path"], base64.b64decode(data["content"]).decode("utf-8", errors="replace")
        if status in (404, 451):
            return None
        time.sleep(2**attempt)
    log(f"  README fetch failed for {full_name}: HTTP {status}")
    return None


def downsample(points: list[list[int]], today: int) -> list[list[int]]:
    """Keep daily points for 30 days, one per week for a year, one per month before."""
    kept: dict[tuple, list[int]] = {}
    for day, stars in sorted(points):
        age = today - day
        if age <= 30:
            key: tuple = ("d", day)
        elif age <= 365:
            key = ("w", day // 7)
        else:
            d = datetime.fromtimestamp(day * 86400, timezone.utc)
            key = ("m", d.year, d.month)
        kept[key] = [day, stars]  # last point of each bucket wins
    return sorted(kept.values())


def load_previous(path: str) -> dict[int, dict]:
    """Languages and README per repo id from a database written by a previous run."""
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    columns = {row[1] for row in db.execute("PRAGMA table_info(repos)")}
    gid = "github_id" if "github_id" in columns else "id"  # databases from before github_id existed
    by_row: dict[int, dict] = {}
    for row_id, github_id, full_name, url, pushed_at in db.execute(
        f"SELECT id, {gid}, full_name, url, pushed_at FROM repos"
    ):
        by_row[row_id] = {
            "github_id": github_id, "full_name": full_name, "url": url, "pushed_at": pushed_at,
            "languages": [], "readme": None, "history": [], "backfilled": None,
        }
    for row_id, name, size, color in db.execute(
        "SELECT rl.repo_id, rl.language, rl.bytes, l.color FROM repo_languages rl"
        " LEFT JOIN languages l ON l.name = rl.language ORDER BY rl.repo_id, rl.bytes DESC"
    ):
        by_row[row_id]["languages"].append((name, size, color))
    for row_id, path_, content in db.execute("SELECT repo_id, path, content FROM readmes"):
        by_row[row_id]["readme"] = (path_, content)
    if db.execute("SELECT 1 FROM sqlite_master WHERE name = 'star_history'").fetchone():
        for row_id, points, backfilled in db.execute("SELECT repo_id, points, backfilled FROM star_history"):
            by_row[row_id]["history"], by_row[row_id]["backfilled"] = json.loads(points), backfilled
    db.close()
    return {p["github_id"]: p for p in by_row.values()}


def build_db(path: str, login: str, repos: list[dict]) -> None:
    if os.path.exists(path):
        os.remove(path)
    db = sqlite3.connect(path)
    db.execute("PRAGMA page_size = 4096")
    db.execute("PRAGMA journal_mode = DELETE")
    db.executescript(SCHEMA)

    colors: dict[str, str | None] = {}
    repos = sorted(repos, key=lambda r: r["starred_at"], reverse=True)
    for rank, r in enumerate(repos, 1):
        langs = r.get("languages", [])
        db.execute(
            "INSERT INTO repos VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                rank, r["id"], r["full_name"], r["owner"], r["name"], r["url"], r["description"], r["homepage"],
                r["language"], ",".join(name for name, _, _ in langs), " ".join(r["topics"]), r["license"],
                r["stars"], r["forks"], r["archived"], r["fork"], r["created_at"], r["pushed_at"], r["starred_at"],
                len(r["readme"][1].encode()) if r.get("readme") else 0,
            ),
        )
        for name, size, color in langs:
            colors[name] = color
            db.execute("INSERT INTO repo_languages VALUES (?,?,?)", (name, rank, size))
        db.executemany("INSERT INTO repo_topics VALUES (?,?)", [(t, rank) for t in set(r["topics"])])
        if r.get("readme"):
            db.execute("INSERT INTO readmes VALUES (?,?,?)", (rank, *r["readme"]))
        if r.get("history"):
            db.execute(
                "INSERT INTO star_history VALUES (?,?,?)",
                (rank, json.dumps(r["history"], separators=(",", ":")), r.get("backfilled")),
            )

    db.executemany("INSERT INTO languages VALUES (?,?)", colors.items())
    db.executescript(
        """
        INSERT INTO facets SELECT 'language', language, COUNT(*) FROM repos
          WHERE language IS NOT NULL GROUP BY language;
        INSERT INTO facets SELECT 'any_language', language, COUNT(*) FROM repo_languages GROUP BY language;
        INSERT INTO facets SELECT 'topic', topic, COUNT(*) FROM repo_topics GROUP BY topic;
        """
    )
    db.executemany(
        "INSERT INTO meta VALUES (?,?)",
        [
            ("login", login),
            ("fetched_at", datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")),
            ("count", str(len(repos))),
        ],
    )
    db.execute("INSERT INTO search (rowid, full_name, description, topics, readme) SELECT * FROM search_source")
    db.execute("INSERT INTO search (search) VALUES ('optimize')")
    db.commit()
    db.execute("ANALYZE")
    db.commit()
    db.execute("VACUUM")
    db.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("output", help="SQLite file to (re)create")
    parser.add_argument("--user", help="GitHub login (default: authenticated gh user)")
    parser.add_argument("--batch-size", type=int, default=10, help="repos per GraphQL details query")
    parser.add_argument("--jobs", type=int, default=6, help="parallel requests")
    parser.add_argument("--max-pages", type=int, help="only fetch the N most recent pages of 100 stars (for testing)")
    parser.add_argument(
        "--previous",
        help="previous database: reuse languages and README of repos not pushed to since",
    )
    parser.add_argument(
        "--refetch-all", action="store_true", help="refetch every README/languages even with --previous"
    )
    parser.add_argument("--release-notes", help="write a markdown changelog vs --previous to this file")
    args = parser.parse_args()

    login = args.user
    if not login:
        status, _, payload = gh_api("user")
        if status != 200:
            raise SystemExit(f"cannot determine GitHub user (HTTP {status}), pass --user")
        login = json.loads(payload)["login"]

    log(f"listing stars of {login}")
    repos = fetch_stars(login, args.jobs, args.max_pages)

    previous = load_previous(args.previous) if args.previous else {}
    today = int(time.time() // 86400)
    stale = []
    for repo in repos:
        prev = previous.get(repo["id"])
        repo["history"] = downsample((prev["history"] if prev else []) + [[today, repo["stars"]]], today)
        repo["backfilled"] = prev["backfilled"] if prev else None
        if prev and prev["pushed_at"] == repo["pushed_at"] and not args.refetch_all:
            repo["languages"], repo["readme"] = prev["languages"], prev["readme"]
        else:
            stale.append(repo)
    if previous:
        log(f"reusing details of {len(repos) - len(stale)} unchanged repos from {args.previous}")
    by_node_id = {r["node_id"]: r for r in stale}

    ids = list(by_node_id)
    batches = [ids[i : i + args.batch_size] for i in range(0, len(ids), args.batch_size)]
    log(f"fetching languages and READMEs of {len(stale)} repos in {len(batches)} batches")
    with ThreadPoolExecutor(args.jobs) as pool:
        for done, nodes in enumerate(pool.map(fetch_details, batches), 1):
            for node in nodes:
                repo = by_node_id[node["id"]]
                langs: dict[str, tuple[str, int, str | None]] = {}
                for e in node["languages"]["edges"]:  # GitHub occasionally lists a language twice
                    langs.setdefault(e["node"]["name"], (e["node"]["name"], e["size"], e["node"]["color"]))
                repo["languages"] = list(langs.values())
                repo["readme"] = readme_from_graphql(node)
            if done % 50 == 0 or done == len(batches):
                log(f"  {done}/{len(batches)} batches")

    missing = [r for r in stale if not r.get("readme") and r["size"] > 0]
    log(f"{len(stale) - len(missing)} READMEs found, {len(missing)} left to look up via REST")
    with ThreadPoolExecutor(args.jobs) as pool:
        for repo, found in zip(missing, pool.map(lambda r: readme_from_rest(r["full_name"]), missing)):
            repo["readme"] = found

    tmp = args.output + ".tmp"
    build_db(tmp, login, repos)
    os.replace(tmp, args.output)
    n_readmes = sum(1 for r in repos if r.get("readme"))
    log(f"wrote {args.output}: {len(repos)} repos, {n_readmes} READMEs, {os.path.getsize(args.output) / 1e6:.1f} MB")

    if args.release_notes:
        write_release_notes(args.release_notes, repos, previous if args.previous else None, len(stale))


def write_release_notes(path: str, repos: list[dict], previous: dict[int, dict] | None, refreshed: int) -> None:
    """Markdown summary of what changed since the previous database; first line is the release title."""
    date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    lines = []
    if previous is None:
        title = f"{date} · {len(repos)} stars"
        lines.append("Full fetch, no previous database.")
    else:
        current = {r["id"] for r in repos}
        added = [r for r in repos if r["id"] not in previous]
        removed = [p for rid, p in previous.items() if rid not in current]
        title = f"{date} · {len(repos)} stars (+{len(added)} / −{len(removed)})"
        lines.append(f"README and languages refreshed for {refreshed} new or updated repositories.")
        for heading, items in (("Starred", added), ("Unstarred", removed)):
            if items:
                lines += ["", f"## {heading} ({len(items)})", ""]
                for r in items:
                    desc = f" — {' '.join(r['description'].split())}" if r.get("description") else ""
                    lines.append(f"- [{r['full_name']}]({r['url']}){desc}")
    with open(path, "w") as f:
        f.write(title + "\n" + "\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
