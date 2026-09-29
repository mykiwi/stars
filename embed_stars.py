"""Embed starred repositories and store each repo's nearest neighbours.

Runs after fetch_stars.py on its database: embeds name, description, topics and
the start of the README with a local fastembed model, keeps the vectors in an
`embeddings` table (reused from --previous when the text did not change), then
uses sqlite-vec to find the most similar repositories and writes them to a
denormalized `similar` table the web app reads directly.
"""

import argparse
import hashlib
import re
import sqlite3
import sys
import time

import sqlite_vec
from fastembed import TextEmbedding

MODEL = "BAAI/bge-small-en-v1.5"
NEIGHBOURS = 8
README_CHARS = 2000

SCHEMA = """
DROP TABLE IF EXISTS embeddings;
DROP TABLE IF EXISTS similar;
CREATE TABLE embeddings (
  repo_id INTEGER PRIMARY KEY REFERENCES repos (id),
  text_hash TEXT NOT NULL,
  vector BLOB NOT NULL
);
CREATE TABLE similar (
  repo_id INTEGER NOT NULL REFERENCES repos (id),
  rank INTEGER NOT NULL,
  similar_id INTEGER NOT NULL REFERENCES repos (id),
  score REAL NOT NULL,
  full_name TEXT NOT NULL,
  description TEXT,
  language TEXT,
  stars INTEGER NOT NULL,
  PRIMARY KEY (repo_id, rank)
) WITHOUT ROWID;
"""


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def clean_readme(text: str) -> str:
    text = re.sub(r"<!--.*?-->|<[^>]+>", " ", text, flags=re.S)
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"https?://\S+|[#*`>|_~=-]{2,}|[#*`>|]", " ", text)
    return " ".join(text.split())[:README_CHARS]


def document(full_name: str, description: str | None, topics: str, readme: str | None) -> str:
    parts = [full_name.replace("/", " / "), description or "", topics.replace(" ", ", "), clean_readme(readme or "")]
    return "\n".join(p for p in parts if p)


def load_previous(path: str) -> dict[int, tuple[str, bytes]]:
    """github_id -> (text_hash, vector) from a previous database, if it has embeddings for this model."""
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        model = db.execute("SELECT value FROM meta WHERE key = 'embedding_model'").fetchone()
        if not model or model[0] != MODEL:
            return {}
        return {
            gid: (h, v)
            for gid, h, v in db.execute(
                "SELECT r.github_id, e.text_hash, e.vector FROM embeddings e JOIN repos r ON r.id = e.repo_id"
            )
        }
    except sqlite3.OperationalError:
        return {}
    finally:
        db.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("database", help="database written by fetch_stars.py, updated in place")
    parser.add_argument("--previous", help="previous database to reuse unchanged embeddings from")
    parser.add_argument(
        "--time-budget",
        type=float,
        help="stop embedding after this many seconds; remaining repos are embedded by the next run",
    )
    args = parser.parse_args()

    db = sqlite3.connect(args.database)
    rows = db.execute(
        "SELECT r.id, r.github_id, r.full_name, r.description, r.topics, m.content"
        " FROM repos r LEFT JOIN readmes m ON m.repo_id = r.id ORDER BY r.id"
    ).fetchall()
    docs = {rid: document(name, desc, topics, readme) for rid, _, name, desc, topics, readme in rows}
    hashes = {rid: hashlib.sha256(text.encode()).hexdigest()[:16] for rid, text in docs.items()}

    previous = load_previous(args.previous) if args.previous else {}
    vectors: dict[int, bytes] = {}
    for rid, gid, *_ in rows:
        prev = previous.get(gid)
        if prev and prev[0] == hashes[rid]:
            vectors[rid] = prev[1]
    todo = [rid for rid, *_ in rows if rid not in vectors]
    log(f"reusing {len(vectors)} embeddings, embedding {len(todo)} repos with {MODEL}")

    if todo:
        start = time.time()
        model = TextEmbedding(MODEL)
        batch = 64
        for offset in range(0, len(todo), batch):
            if args.time_budget and time.time() - start > args.time_budget:
                log(f"  time budget reached, {len(todo) - offset} repos left for the next run")
                break
            chunk = todo[offset : offset + batch]
            for rid, vec in zip(chunk, model.embed([docs[rid] for rid in chunk], batch_size=batch)):
                vectors[rid] = sqlite_vec.serialize_float32(vec.tolist())
            done = offset + len(chunk)
            if done % 512 == 0 or done == len(todo):
                log(f"  {done}/{len(todo)} ({time.time() - start:.0f}s, {done / (time.time() - start):.1f} docs/s)")

    db.enable_load_extension(True)
    sqlite_vec.load(db)
    db.enable_load_extension(False)
    db.executescript(SCHEMA)
    db.executemany("INSERT INTO embeddings VALUES (?,?,?)", [(rid, hashes[rid], v) for rid, v in vectors.items()])

    if not vectors:
        db.commit()
        log("no embeddings yet")
        return
    dim = len(next(iter(vectors.values()))) // 4
    db.execute(f"CREATE VIRTUAL TABLE temp.knn USING vec0 (embedding float[{dim}] distance_metric=cosine)")
    db.execute("INSERT INTO temp.knn (rowid, embedding) SELECT repo_id, vector FROM embeddings")
    meta = {rid: (name, desc) for rid, _, name, desc, *_ in rows}
    details = dict(((rid, (lang, stars)) for rid, lang, stars in db.execute("SELECT id, language, stars FROM repos")))
    similar = []
    for rid, vec in vectors.items():
        hits = db.execute(
            "SELECT rowid, distance FROM temp.knn WHERE embedding MATCH ? AND k = ?", (vec, NEIGHBOURS + 1)
        ).fetchall()
        rank = 0
        for other, distance in hits:
            if other == rid or rank == NEIGHBOURS:
                continue
            rank += 1
            name, desc = meta[other]
            similar.append((rid, rank, other, round(1 - distance, 4), name, desc, *details[other]))
    db.executemany("INSERT INTO similar VALUES (?,?,?,?,?,?,?,?)", similar)
    db.execute("DROP TABLE temp.knn")
    db.execute("INSERT OR REPLACE INTO meta VALUES ('embedding_model', ?)", (MODEL,))
    db.commit()
    db.execute("VACUUM")
    db.close()
    log(f"wrote {len(vectors)} embeddings and {len(similar)} neighbours to {args.database}")


if __name__ == "__main__":
    main()
