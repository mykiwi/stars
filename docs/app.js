"use strict";

const PAGE_SIZE = 50;
const HL_START = "\u0002";
const HL_END = "\u0003";
const SORTS = {
  relevance: "bm25(search, 10.0, 4.0, 4.0, 1.0)",
  starred: "r.starred_at DESC",
  stars: "r.stars DESC",
  pushed: "r.pushed_at DESC",
  name: "r.full_name COLLATE NOCASE",
};
const DEFAULTS = { q: "", lang: "", anyLang: false, topic: "", sort: "relevance", hideArchived: false, hideForks: false };

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
};

let db;
let colors = new Map();
let state = { ...DEFAULTS };
let page = 0;
let total = 0;
let generation = 0;
let repoCount = 0;

async function query(sql, params = []) {
  return db.query(sql, params);
}

function readState() {
  const p = new URLSearchParams(location.search);
  state = { ...DEFAULTS };
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (!p.has(k)) continue;
    state[k] = typeof v === "boolean" ? p.get(k) === "1" : p.get(k);
  }
  if (!SORTS[state.sort]) state.sort = DEFAULTS.sort;
  $("q").value = state.q;
  $("lang").value = state.lang;
  $("anyLang").checked = state.anyLang;
  $("topic").value = state.topic;
  $("sort").value = state.sort;
  $("hideArchived").checked = state.hideArchived;
  $("hideForks").checked = state.hideForks;
}

function writeState() {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(state)) {
    if (v === DEFAULTS[k]) continue;
    p.set(k, typeof v === "boolean" ? "1" : v);
  }
  const qs = p.toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

function ftsQuery(text) {
  const terms = text.match(/[\p{L}\p{N}]+/gu) || [];
  return terms.map((t) => `"${t}"*`).join(" ");
}

function buildWhere() {
  const joins = [];
  const where = [];
  const params = [];
  const fts = ftsQuery(state.q);
  if (fts) {
    joins.push("JOIN search ON search.rowid = r.id");
    where.push("search MATCH ?");
    params.push(fts);
  }
  if (state.lang) {
    where.push(state.anyLang ? "r.id IN (SELECT repo_id FROM repo_languages WHERE language = ?)" : "r.language = ?");
    params.push(state.lang);
  }
  if (state.topic) {
    where.push("r.id IN (SELECT repo_id FROM repo_topics WHERE topic = ?)");
    params.push(state.topic.trim().toLowerCase());
  }
  if (state.hideArchived) where.push("NOT r.archived");
  if (state.hideForks) where.push("NOT r.fork");
  return { fts, from: `FROM repos r ${joins.join(" ")}`, where: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

let loadingMore = false;

async function search(reset) {
  if (!reset) {
    if (loadingMore) return;
    loadingMore = true;
  }
  try {
    await runSearch(reset);
  } finally {
    if (!reset) loadingMore = false;
  }
}

async function runSearch(reset) {
  const gen = reset ? ++generation : generation;
  if (reset) page = 0;
  const { fts, from, where, params } = buildWhere();
  const sort = state.sort === "relevance" && !fts ? SORTS.starred : SORTS[state.sort];
  try {
    if (reset) {
      $("count").textContent = "Recherche…";
      if (where) {
        const [{ n }] = await query(`SELECT COUNT(*) AS n ${from} ${where}`, params);
        if (gen !== generation) return;
        total = n;
      } else {
        total = repoCount;
      }
    }
    const rows = await query(
      `SELECT r.* ${from} ${where} ORDER BY ${sort}, r.id LIMIT ${PAGE_SIZE} OFFSET ${page * PAGE_SIZE}`,
      params,
    );
    if (gen !== generation) return;
    if (reset) $("results").replaceChildren();
    $("results").append(...rows.map(renderRepo));
    page++;
    $("count").textContent = `${total.toLocaleString("fr")} repo${total > 1 ? "s" : ""}`;
    $("more").hidden = page * PAGE_SIZE >= total;
    $("error").hidden = true;
    // Snippets read whole READMEs over HTTP: only for the top results, skipping huge ones.
    const snippetIds = rows.filter((r) => r.readme_size && r.readme_size < 65536).slice(0, 10).map((r) => r.id);
    if (fts && reset && snippetIds.length) loadSnippets(gen, fts, snippetIds);
  } catch (e) {
    showError(e);
  }
}

async function loadSnippets(gen, fts, ids) {
  const rows = await query(
    `SELECT rowid AS id, snippet(search, 3, ?, ?, '…', 24) AS s FROM search
     WHERE search MATCH ? AND rowid IN (${ids.map(() => "?").join(",")})`,
    [HL_START, HL_END, fts, ...ids],
  );
  if (gen !== generation) return;
  for (const { id, s } of rows) {
    if (!s || !s.includes(HL_START)) continue;
    const slot = document.querySelector(`[data-id="${id}"] .snippet`);
    if (slot) slot.replaceChildren(...highlight(s));
  }
}

// Snippets come from raw README source: drop HTML tags and markdown punctuation.
function cleanSnippet(text) {
  return text
    .replace(/<!--|-->/g, " ")
    .replace(/<\/?[a-z][^<>]*>?/gi, " ")
    .replace(/!?\[([^\]]*)\]\([^)\s]*\)?/g, "$1")
    .replace(/[*`#>|~]+|={3,}|-{3,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function highlight(text) {
  const out = [];
  let buf = "";
  let marked = false;
  const flush = () => {
    if (buf) out.push(marked ? el("mark", { textContent: buf }) : buf);
    buf = "";
  };
  for (const ch of cleanSnippet(text)) {
    if (ch === HL_START || ch === HL_END) {
      flush();
      marked = ch === HL_START;
    } else {
      buf += ch;
    }
  }
  flush();
  return out;
}

const fmtNum = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
const fmtDate = (s) => (s ? s.slice(0, 10) : "?");

function langBadge(name) {
  const dot = el("span", { className: "dot" });
  dot.style.background = colors.get(name) || "#888";
  const b = el("button", { type: "button", className: "lang", title: `Filtrer sur ${name}` }, dot, name);
  b.onclick = (ev) => {
    ev.stopPropagation();
    setFilter({ lang: name });
  };
  return b;
}

function renderRepo(r) {
  const title = el("a", { href: r.url, target: "_blank", rel: "noopener", textContent: r.full_name });
  title.onclick = (ev) => ev.stopPropagation();
  const topics = r.topics
    ? r.topics.split(" ").map((t) => {
        const b = el("button", { type: "button", className: "topic", textContent: t });
        b.onclick = (ev) => {
          ev.stopPropagation();
          setFilter({ topic: t });
        };
        return b;
      })
    : [];
  const langs = r.languages ? r.languages.split(",").slice(0, 4) : [];
  const li = el(
    "li",
    { className: "repo", tabIndex: 0 },
    el(
      "div",
      { className: "head" },
      el("h3", {}, title),
      el("span", { className: "stars", title: `${r.stars} stars` }, `★ ${fmtNum(r.stars)}`),
    ),
    r.description && el("p", { className: "desc", textContent: r.description }),
    el("p", { className: "snippet" }),
    el(
      "div",
      { className: "meta" },
      ...langs.map(langBadge),
      r.license && el("span", { textContent: r.license }),
      r.archived ? el("span", { className: "badge", textContent: "archivé" }) : null,
      r.fork ? el("span", { className: "badge", textContent: "fork" }) : null,
      el("span", { title: "date de star", textContent: `☆ ${fmtDate(r.starred_at)}` }),
      el("span", { title: "dernier push", textContent: `⟳ ${fmtDate(r.pushed_at)}` }),
    ),
    topics.length ? el("div", { className: "topics" }, ...topics) : null,
  );
  li.dataset.id = r.id;
  li.onclick = () => openDetail(r);
  li.onkeydown = (ev) => ev.key === "Enter" && openDetail(r);
  return li;
}

let readmeBase = null;

function setupPurify() {
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (!readmeBase) return;
    const rewrite = (attr, base) => {
      const v = node.getAttribute(attr);
      if (!v || v.startsWith("#") || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(v)) return;
      try {
        node.setAttribute(attr, new URL(v.replace(/^\//, ""), v.startsWith("/") ? readmeBase.root : base).href);
      } catch {}
    };
    if (node.tagName === "IMG") rewrite("src", readmeBase.raw);
    if (node.tagName === "A") {
      rewrite("href", readmeBase.blob);
      if (!node.getAttribute("href")?.startsWith("#")) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
    }
  });
}

async function openDetail(r) {
  $("detailTitle").textContent = r.full_name;
  $("detailTitle").href = r.url;
  $("detailMeta").textContent = [
    `★ ${r.stars.toLocaleString("fr")}`,
    r.languages.replaceAll(",", ", "),
    r.homepage,
    `star le ${fmtDate(r.starred_at)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const box = $("readme");
  box.replaceChildren(el("p", { className: "muted", textContent: "Chargement du README…" }));
  $("detail").showModal();
  try {
    const [m] = await query("SELECT path, content FROM readmes WHERE repo_id = ?", [r.id]);
    if (!m) return box.replaceChildren(el("p", { className: "muted", textContent: "Pas de README." }));
    const dir = m.path.includes("/") ? m.path.slice(0, m.path.lastIndexOf("/") + 1) : "";
    readmeBase = {
      raw: `https://raw.githubusercontent.com/${r.full_name}/HEAD/${dir}`,
      blob: `https://github.com/${r.full_name}/blob/HEAD/${dir}`,
      root: `https://github.com/${r.full_name}/blob/HEAD/`,
    };
    if (/\.(md|markdown|mdx)$/i.test(m.path) || !m.path.includes(".")) {
      box.innerHTML = DOMPurify.sanitize(marked.parse(m.content, { gfm: true }));
    } else {
      box.replaceChildren(el("pre", { textContent: m.content }));
    }
  } catch (e) {
    box.replaceChildren(el("p", { className: "error", textContent: String(e) }));
  } finally {
    readmeBase = null;
  }
}

async function loadLanguages() {
  const rows = await query("SELECT name, count AS n FROM facets WHERE kind = ? ORDER BY count DESC, name", [
    state.anyLang ? "any_language" : "language",
  ]);
  $("lang").replaceChildren(
    el("option", { value: "", textContent: "Tous" }),
    ...rows.map((l) => el("option", { value: l.name, textContent: `${l.name} (${l.n})` })),
  );
  if (state.lang && !rows.some((l) => l.name === state.lang)) {
    $("lang").append(el("option", { value: state.lang, textContent: state.lang }));
  }
  $("lang").value = state.lang;
}

let topicsLoaded = false;

async function loadTopics() {
  if (topicsLoaded) return;
  topicsLoaded = true;
  const rows = await query("SELECT name, count AS n FROM facets WHERE kind = 'topic' ORDER BY count DESC LIMIT 1000");
  $("topics").replaceChildren(...rows.map((t) => el("option", { value: t.name, label: `${t.name} (${t.n})` })));
}

async function setFilter(patch) {
  const anyLang = state.anyLang;
  Object.assign(state, patch);
  writeState();
  readState();
  if (state.anyLang !== anyLang) await loadLanguages();
  search(true);
  scrollTo({ top: 0 });
}

function readStateFromDom() {
  state.q = $("q").value;
  state.lang = $("lang").value;
  state.anyLang = $("anyLang").checked;
  state.topic = $("topic").value.trim();
  state.sort = $("sort").value;
  state.hideArchived = $("hideArchived").checked;
  state.hideForks = $("hideForks").checked;
}

function onChange() {
  readStateFromDom();
  writeState();
  search(true);
}

function showError(e) {
  console.error(e);
  $("error").textContent = `Erreur : ${e.message || e}`;
  $("error").hidden = false;
}

async function main() {
  setupPurify();
  readState();
  const cfg = await (await fetch("db.json", { cache: "no-cache" })).json();
  // Resolved here: the worker would resolve a relative URL against vendor/.
  const dbUrl = new URL(cfg.url, location.href).href;
  const worker = await createDbWorker(
    [{ from: "inline", config: { serverMode: "full", url: dbUrl, requestChunkSize: 16384 } }],
    new URL("vendor/sqlite.worker.js", location.href).href,
    new URL("vendor/sql-wasm.wasm", location.href).href,
  );
  db = worker.db;
  window.stats = () => worker.worker.getStats();
  $("download").href = cfg.url;
  $("download").textContent += ` (${(cfg.size / 1e6).toFixed(0)} Mo)`;
  $("download").hidden = false;

  const meta = Object.fromEntries((await query("SELECT key, value FROM meta")).map((m) => [m.key, m.value]));
  colors = new Map((await query("SELECT name, color FROM languages")).map((l) => [l.name, l.color]));
  repoCount = Number(meta.count);
  $("stats").textContent = `${Number(meta.count).toLocaleString("fr")} stars de @${meta.login} · màj ${fmtDate(meta.fetched_at)}`;
  document.title = `Stars de @${meta.login}`;

  await loadLanguages();
  search(true);

  let timer;
  $("q").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 250);
  });
  $("anyLang").addEventListener("change", async () => {
    readStateFromDom();
    await loadLanguages();
    onChange();
  });
  $("topic").addEventListener("change", onChange);
  $("topic").addEventListener("focus", loadTopics);
  for (const id of ["lang", "sort", "hideArchived", "hideForks"]) $(id).addEventListener("change", onChange);
  $("reset").onclick = () => setFilter({ ...DEFAULTS });
  $("more").onclick = () => search(false);
  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && !$("more").hidden) search(false);
  }).observe($("more"));
  $("closeDetail").onclick = () => $("detail").close();
  $("detail").addEventListener("click", (ev) => ev.target === $("detail") && $("detail").close());
}

main().catch(showError);
