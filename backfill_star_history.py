"""Backfill past star counts from star-history.com charts into a stars database.

GitHub no longer exposes other repositories' dated stargazers, so the past is
read back from https://api.star-history.com/svg charts (see star_history_svg).
The service rate limits bulk use: requests are sequential and spaced out, a
refusal (403/429/5xx) pauses the run (or stops it with --stop-when-blocked),
and downloaded SVGs are cached so an interrupted run resumes where it stopped.
A chart whose last point does not match the current star count is rejected and
retried after a week.
"""

import argparse
import json
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import fetch_stars
import star_history_svg

USER_AGENT = "mykiwi-stars-backfill (+https://github.com/mykiwi/stars)"
RETRY_FAILED_AFTER = timedelta(days=7)
BLOCKED_PAUSE = 15 * 60


class Blocked(Exception):
    pass


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def download(full_name: str) -> str:
    url = "https://api.star-history.com/svg?" + urllib.parse.urlencode({"repos": full_name, "type": "Date"})
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            return resp.read().decode()
    except urllib.error.HTTPError as e:
        if e.code in (403, 429) or e.code >= 500:
            raise Blocked(f"HTTP {e.code}") from e
        raise ValueError(f"HTTP {e.code}") from e
    except (urllib.error.URLError, TimeoutError) as e:
        raise Blocked(str(e)) from e


def best_mark(a: str | None, b: str | None) -> str | None:
    """Prefer a successful backfill date over a failure, the latest of each."""
    ok = [m for m in (a, b) if m and not m.startswith("failed:")]
    if ok:
        return max(ok)
    return max((m for m in (a, b) if m), default=None)


def merge_from(db: sqlite3.Connection, path: str, today_n: int) -> int:
    """Union star_history of another database into db, matching repositories by GitHub id."""
    src = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    theirs = {
        gid: (json.loads(points), mark)
        for gid, points, mark in src.execute(
            "SELECT r.github_id, h.points, h.backfilled FROM star_history h JOIN repos r ON r.id = h.repo_id"
        )
    }
    src.close()
    merged = 0
    for rid, gid, points, mark in db.execute(
        "SELECT r.id, r.github_id, h.points, h.backfilled FROM repos r LEFT JOIN star_history h ON h.repo_id = r.id"
    ).fetchall():
        if gid not in theirs:
            continue
        their_points, their_mark = theirs[gid]
        points = fetch_stars.downsample((json.loads(points) if points else []) + their_points, today_n)
        db.execute(
            "INSERT OR REPLACE INTO star_history VALUES (?,?,?)",
            (rid, json.dumps(points, separators=(",", ":")), best_mark(mark, their_mark)),
        )
        merged += 1
    return merged


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("database", help="database written by fetch_stars.py, updated in place")
    parser.add_argument("--cache", default=".star-history-cache", help="directory for downloaded SVGs")
    parser.add_argument("--limit", type=int, help="backfill at most N repositories (most recent stars first)")
    parser.add_argument("--delay", type=float, default=30.0, help="seconds between requests to star-history.com")
    parser.add_argument("--stop-when-blocked", action="store_true", help="stop instead of pausing when refused")
    parser.add_argument(
        "--merge-from",
        help="only merge the star history of another database (e.g. a local backfill) into DATABASE",
    )
    args = parser.parse_args()

    cache = Path(args.cache)
    cache.mkdir(parents=True, exist_ok=True)
    today = date.today()
    today_n = (today - date(1970, 1, 1)).days
    db = sqlite3.connect(args.database)
    if args.merge_from:
        n = merge_from(db, args.merge_from, today_n)
        db.commit()
        db.execute("VACUUM")
        done = db.execute(
            "SELECT COUNT(*) FROM star_history WHERE backfilled IS NOT NULL AND backfilled NOT LIKE 'failed:%'"
        ).fetchone()[0]
        db.close()
        log(f"merged star history of {n} repositories; {done} are backfilled")
        return
    rows = db.execute(
        "SELECT r.id, r.github_id, r.full_name, r.stars, h.points, h.backfilled"
        " FROM repos r LEFT JOIN star_history h ON h.repo_id = r.id ORDER BY r.id"
    ).fetchall()

    def due(backfilled: str | None) -> bool:
        if backfilled is None:
            return True
        if backfilled.startswith("failed:"):
            return date.fromisoformat(backfilled[7:]) + RETRY_FAILED_AFTER <= today
        return False

    todo = [r for r in rows if due(r[5])][: args.limit]
    log(f"backfilling {len(todo)} of {len(rows)} repositories from star-history.com")
    ok = failed = 0
    start = time.time()
    i = 0
    while i < len(todo):
        rid, gid, full_name, stars, points, _ = todo[i]
        cached = cache / f"{gid}.svg"
        current = json.loads(points) if points else [[today_n, stars]]
        try:
            if not (cached.exists() and cached.stat().st_mtime > time.time() - 7 * 86400):
                time.sleep(args.delay)
                cached.write_text(download(full_name))
            generated = datetime.fromtimestamp(cached.stat().st_mtime, timezone.utc)
            parsed = star_history_svg.parse(cached.read_text(), generated)
            if abs(parsed[-1][1] - stars) > max(5, 0.10 * stars):
                raise ValueError(f"last point {parsed[-1][1]} does not match {stars} stars")
            history = [[(date.fromisoformat(d) - date(1970, 1, 1)).days, n] for d, n in parsed]
            merged, mark = fetch_stars.downsample(history + current, today_n), today.isoformat()
            ok += 1
        except Blocked as e:
            db.commit()
            if args.stop_when_blocked:
                log(f"  star-history.com refused ({e}), stopping; the next run resumes")
                break
            log(f"  star-history.com refused ({e}), pausing {BLOCKED_PAUSE // 60} min")
            time.sleep(BLOCKED_PAUSE)
            continue  # same repository again
        except ValueError as e:
            merged, mark = current, f"failed:{today.isoformat()}"
            failed += 1
            log(f"  {full_name}: {e}")
        db.execute(
            "INSERT OR REPLACE INTO star_history VALUES (?,?,?)",
            (rid, json.dumps(merged, separators=(",", ":")), mark),
        )
        i += 1
        if i % 25 == 0 or i == len(todo):
            db.commit()
            rate = i / (time.time() - start)
            log(f"  {i}/{len(todo)}: {ok} ok, {failed} rejected, ETA {(len(todo) - i) / rate / 3600:.1f} h")
    db.commit()
    db.execute("VACUUM")
    db.close()
    log(f"done: {ok} backfilled, {failed} rejected")


if __name__ == "__main__":
    main()
