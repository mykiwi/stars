"""Embed starred repositories and store each repo's nearest neighbours.

Runs after fetch_stars.py on its database: embeds name, description, topics and
the start of the README with a local fastembed model, keeps the vectors in an
`embeddings` table (reused from --previous when the text did not change), then
uses sqlite-vec to find the most similar repositories and writes them to a
denormalized `similar` table the web app reads directly.
"""

import argparse
import hashlib
import math
import re
import sqlite3
import sys
import time

import numpy as np
import sqlite_vec
from fastembed import TextEmbedding

MODEL = "BAAI/bge-small-en-v1.5"
NEIGHBOURS = 8
README_CHARS = 2000
DUPLICATE_SCORE = 0.90
GENERIC_TOPICS = {"hacktoberfest", "hacktoberfest-accepted", "good-first-issue", "open-source", "opensource", "free"}
STOPWORDS = set(
    "a an and are as at be by for from in into is it its of on or that the this to with your you based using "
    "simple fast library tool tools framework written open source project support built".split()
)

SCHEMA = """
DROP TABLE IF EXISTS embeddings;
DROP TABLE IF EXISTS similar;
DROP TABLE IF EXISTS clusters;
DROP TABLE IF EXISTS repo_clusters;
DROP TABLE IF EXISTS duplicates;
-- Themes: k-means over the embeddings, labelled with their most distinctive topics.
CREATE TABLE clusters (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  size INTEGER NOT NULL,
  languages TEXT NOT NULL,
  examples TEXT NOT NULL
);
CREATE TABLE repo_clusters (
  cluster_id INTEGER NOT NULL REFERENCES clusters (id),
  repo_id INTEGER NOT NULL REFERENCES repos (id),
  PRIMARY KEY (cluster_id, repo_id)
) WITHOUT ROWID;
CREATE INDEX repo_clusters_repo ON repo_clusters (repo_id);
-- Near-identical pairs (often an abandoned project and its maintained fork), side 0/1 per pair.
CREATE TABLE duplicates (
  pair INTEGER NOT NULL,
  side INTEGER NOT NULL,
  score REAL NOT NULL,
  repo_id INTEGER NOT NULL REFERENCES repos (id),
  full_name TEXT NOT NULL,
  description TEXT,
  stars INTEGER NOT NULL,
  pushed_at TEXT,
  archived INTEGER NOT NULL,
  fork INTEGER NOT NULL,
  PRIMARY KEY (pair, side)
) WITHOUT ROWID;
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


def kmeans(x: np.ndarray, k: int, iterations: int = 60, seed: int = 0) -> np.ndarray:
    """Spherical k-means (cosine) with k-means++ seeding; returns a cluster index per row."""
    rng = np.random.default_rng(seed)
    centers = [x[rng.integers(len(x))]]
    dist = 1 - x @ centers[0]
    for _ in range(1, k):
        weights = np.clip(dist, 0, None) ** 2
        centers.append(x[rng.choice(len(x), p=weights / weights.sum())])
        dist = np.minimum(dist, 1 - x @ centers[-1])
    c = np.stack(centers)
    labels = np.zeros(len(x), dtype=int)
    for _ in range(iterations):
        labels = np.argmax(x @ c.T, axis=1)
        new = np.stack([x[labels == j].mean(axis=0) if (labels == j).any() else c[j] for j in range(k)])
        new /= np.linalg.norm(new, axis=1, keepdims=True)
        if np.allclose(new, c, atol=1e-6):
            break
        c = new
    return labels


def cluster_label(members: list[tuple], topic_df: dict[str, int], total: int) -> str:
    """Most distinctive topics of a cluster (tf-idf like), falling back to description words."""
    counts: dict[str, int] = {}
    for m in members:
        for t in set(m[2].split()) - GENERIC_TOPICS:
            counts[t] = counts.get(t, 0) + 1
    scored = sorted(
        ((c * math.log(total / topic_df[t]), t) for t, c in counts.items() if c >= 2 and c >= 0.04 * len(members)),
        reverse=True,
    )
    if len(scored) < 2:
        words: dict[str, int] = {}
        for m in members:
            for w in set(re.findall(r"[a-z][a-z0-9+#-]{2,}", (m[3] or "").lower())) - STOPWORDS:
                words[w] = words.get(w, 0) + 1
        scored += sorted(((c, w) for w, c in words.items() if c >= 2), reverse=True)
    label = []
    for _, t in scored:
        if not any(t in l or l in t for l in label):
            label.append(t)
        if len(label) == 3:
            break
    return " · ".join(label) or "divers"


def write_themes(db: sqlite3.Connection, vectors: dict[int, bytes]) -> int:
    repos = {
        rid: (gid, name, topics, desc, lang, stars)
        for rid, gid, name, topics, desc, lang, stars in db.execute(
            "SELECT id, github_id, full_name, topics, description, language, stars FROM repos"
        )
    }
    ids = sorted((rid for rid in vectors if rid in repos), key=lambda rid: repos[rid][0])  # stable order
    if len(ids) < 10:
        return 0
    x = np.stack([np.frombuffer(vectors[rid], dtype=np.float32) for rid in ids])
    x /= np.linalg.norm(x, axis=1, keepdims=True)
    k = max(2, round(math.sqrt(len(ids))))
    labels = kmeans(x, k)
    topic_df: dict[str, int] = {}
    for r in repos.values():
        for t in set(r[2].split()):
            topic_df[t] = topic_df.get(t, 0) + 1
    groups = [[rid for rid, lab in zip(ids, labels) if lab == j] for j in range(k)]
    groups = sorted((g for g in groups if g), key=len, reverse=True)
    for cid, group in enumerate(groups, 1):
        members = [repos[rid] for rid in group]
        langs: dict[str, int] = {}
        for m in members:
            if m[4]:
                langs[m[4]] = langs.get(m[4], 0) + 1
        top_langs = ",".join(l for l, _ in sorted(langs.items(), key=lambda kv: -kv[1])[:3])
        examples = ",".join(m[1] for m in sorted(members, key=lambda m: -m[5])[:3])
        db.execute(
            "INSERT INTO clusters VALUES (?,?,?,?,?)",
            (cid, cluster_label(members, topic_df, len(repos)), len(group), top_langs, examples),
        )
        db.executemany("INSERT INTO repo_clusters VALUES (?,?)", [(cid, rid) for rid in group])
    return len(groups)


def write_duplicates(db: sqlite3.Connection) -> int:
    pairs = db.execute(
        "SELECT MIN(repo_id, similar_id), MAX(repo_id, similar_id), MAX(score) FROM similar"
        " WHERE score >= ? GROUP BY 1, 2 ORDER BY 3 DESC",
        (DUPLICATE_SCORE,),
    ).fetchall()
    for pair, (a, b, score) in enumerate(pairs, 1):
        for side, rid in enumerate((a, b)):
            db.execute(
                "INSERT INTO duplicates SELECT ?, ?, ?, id, full_name, description, stars, pushed_at, archived, fork"
                " FROM repos WHERE id = ?",
                (pair, side, score, rid),
            )
    return len(pairs)


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
    n_themes = write_themes(db, vectors)
    n_duplicates = write_duplicates(db)
    db.execute("INSERT OR REPLACE INTO meta VALUES ('embedding_model', ?)", (MODEL,))
    db.commit()
    db.execute("VACUUM")
    db.close()
    log(
        f"wrote {len(vectors)} embeddings, {len(similar)} neighbours, {n_themes} themes"
        f" and {n_duplicates} likely duplicates to {args.database}"
    )


if __name__ == "__main__":
    main()
