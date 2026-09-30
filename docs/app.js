"use strict";

const PAGE_SIZE = 50;
const HL_START = "\u0002";
const HL_END = "\u0003";
const SORTS = {
  relevance: "bm25(search, 10.0, 4.0, 4.0, 1.0)",
  starred: "r.starred_at DESC",
  stars: "r.stars DESC",
  pushed: "r.pushed_at DESC",
  oldest: "r.pushed_at ASC",
  name: "r.full_name COLLATE NOCASE",
};
const DEFAULTS = {
  view: "list",
  q: "",
  lang: "",
  anyLang: false,
  theme: "",
  topic: "",
  sort: "relevance",
  activity: "",
  hideForks: false,
};
const ACTIVITY = {
  active: "r.pushed_at >= date('now', '-1 year')",
  stale: "r.pushed_at < date('now', '-2 years')",
  archived: "r.archived",
  live: "NOT r.archived",
};
const VIEWS = ["list", "themes", "duplicates"];

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
  if (!VIEWS.includes(state.view)) state.view = DEFAULTS.view;
  if (state.activity && !ACTIVITY[state.activity]) state.activity = "";
  $("q").value = state.q;
  $("lang").value = state.lang;
  $("anyLang").checked = state.anyLang;
  $("topic").value = state.topic;
  $("sort").value = state.sort;
  $("theme").value = state.theme;
  $("activity").value = state.activity;
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
  if (state.theme) {
    where.push("r.id IN (SELECT repo_id FROM repo_clusters WHERE cluster_id = ?)");
    params.push(Number(state.theme));
  }
  if (state.activity) where.push(ACTIVITY[state.activity]);
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
    loadSparklines(gen, rows.map((r) => r.id));
  } catch (e) {
    showError(e);
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";
const DAY_MS = 86400000;
const fmtDay = (d) => new Date(d * DAY_MS).toISOString().slice(0, 10);

function chart(points, width, height, pad) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const sx = (d) => pad + (x1 === x0 ? 0 : ((d - x0) / (x1 - x0)) * (width - 2 * pad));
  const sy = (v) => height - pad - (y1 === y0 ? 0 : ((v - y0) / (y1 - y0)) * (height - 2 * pad));
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", points.map((p, i) => `${i ? "L" : "M"}${sx(p[0]).toFixed(1)} ${sy(p[1]).toFixed(1)}`).join(""));
  path.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(path);
  return svg;
}

const historyTitle = (points) => {
  const [first, last] = [points[0], points[points.length - 1]];
  return `${first[1].toLocaleString("fr")} stars le ${fmtDay(first[0])} → ${last[1].toLocaleString("fr")} le ${fmtDay(last[0])}`;
};

async function loadSparklines(gen, ids) {
  if (!ids.length) return;
  let rows;
  try {
    rows = await query(`SELECT repo_id, points FROM star_history WHERE repo_id IN (${ids.map(() => "?").join(",")})`, ids);
  } catch {
    return; // database built before star history existed
  }
  if (gen !== generation) return;
  for (const { repo_id, points } of rows) {
    const pts = JSON.parse(points);
    if (pts.length < 3) continue;
    const slot = document.querySelector(`[data-id="${repo_id}"] .spark`);
    if (!slot) continue;
    slot.replaceChildren(chart(pts, 60, 16, 1));
    slot.title = historyTitle(pts);
  }
}

async function loadHistory(r) {
  $("history").hidden = true;
  let rows = [];
  try {
    rows = await query("SELECT points, backfilled FROM star_history WHERE repo_id = ?", [r.id]);
  } catch {
    return;
  }
  const pts = rows.length ? JSON.parse(rows[0].points) : [];
  const backfilled = rows.length && rows[0].backfilled && !rows[0].backfilled.startsWith("failed:");
  $("historyLink").href = `https://www.star-history.com/#${r.full_name}&Date`;
  if (backfilled && pts.length >= 3) {
    $("historyChart").className = "";
    $("historyChart").replaceChildren(chart(pts, 600, 90, 3));
    $("historyStart").textContent = `${fmtDay(pts[0][0])} · ${pts[0][1].toLocaleString("fr")} ★`;
    $("historyEnd").textContent = `${fmtDay(pts[pts.length - 1][0])} · ${pts[pts.length - 1][1].toLocaleString("fr")} ★`;
  } else {
    // Not backfilled yet: show star-history.com's own chart, loaded on demand.
    const img = el("img", {
      loading: "lazy",
      alt: `Évolution des stars de ${r.full_name}`,
      src: `https://api.star-history.com/svg?${new URLSearchParams({ repos: r.full_name, type: "Date" })}`,
    });
    $("historyChart").className = "external";
    $("historyChart").replaceChildren(img);
    $("historyStart").textContent = "";
    $("historyEnd").textContent = "";
  }
  $("history").hidden = false;
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
      el("span", { className: "stars", title: `${r.stars} stars` }, el("span", { className: "spark" }), `★ ${fmtNum(r.stars)}`),
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
  if (!$("detail").open) $("detail").showModal();
  $("detail").scrollTop = 0;
  loadSimilar(r.id);
  loadRepoTheme(r.id);
  loadHistory(r);
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

async function loadRepoTheme(id) {
  $("detailTheme").hidden = true;
  let rows = [];
  try {
    rows = await query(
      "SELECT c.id, c.label FROM repo_clusters rc JOIN clusters c ON c.id = rc.cluster_id WHERE rc.repo_id = ?",
      [id],
    );
  } catch {
    return;
  }
  if (!rows.length) return;
  const b = $("detailTheme").querySelector("button");
  b.textContent = rows[0].label;
  b.onclick = () => {
    $("detail").close();
    setFilter({ view: "list", theme: String(rows[0].id) });
  };
  $("detailTheme").hidden = false;
}

async function loadSimilar(id) {
  $("similar").hidden = true;
  let rows;
  try {
    rows = await query("SELECT * FROM similar WHERE repo_id = ? ORDER BY rank", [id]);
  } catch {
    return; // database built before similar projects existed
  }
  if (!rows.length) return;
  $("similarList").replaceChildren(
    ...rows.map((s) => {
      const b = el(
        "button",
        { type: "button", title: s.description || "" },
        el("strong", { textContent: s.full_name }),
        el("span", { className: "muted", textContent: ` ★ ${fmtNum(s.stars)}${s.language ? ` · ${s.language}` : ""}` }),
        s.description && el("span", { className: "desc", textContent: s.description }),
      );
      b.onclick = async () => {
        const [repo] = await query("SELECT * FROM repos WHERE id = ?", [s.similar_id]);
        if (repo) openDetail(repo);
      };
      return el("li", {}, b);
    }),
  );
  $("similar").hidden = false;
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
  refresh();
  scrollTo({ top: 0 });
}

function refresh() {
  for (const b of document.querySelectorAll("#views button")) b.classList.toggle("active", b.dataset.view === state.view);
  const list = state.view === "list";
  for (const id of ["count", "results"]) $(id).hidden = !list;
  $("themesView").hidden = state.view !== "themes";
  $("duplicatesView").hidden = state.view !== "duplicates";
  if (list) return search(true);
  $("more").hidden = true;
  generation++; // drop in-flight list results
  (state.view === "themes" ? renderThemes() : renderDuplicates()).catch(showError);
}

async function loadThemes() {
  let rows = [];
  try {
    rows = await query("SELECT id, label, size FROM clusters ORDER BY label");
  } catch {
    return; // database built before themes existed
  }
  $("theme").replaceChildren(
    el("option", { value: "", textContent: "Tous" }),
    ...rows.map((c) => el("option", { value: String(c.id), textContent: `${c.label} (${c.size})` })),
  );
  $("theme").value = state.theme;
}

async function renderThemes() {
  const rows = await query("SELECT * FROM clusters ORDER BY size DESC");
  $("themesList").replaceChildren(
    ...rows.map((c) => {
      const b = el(
        "button",
        { type: "button" },
        el("strong", { textContent: c.label }),
        el("span", { className: "muted", textContent: `${c.size} repos · ${c.languages.replaceAll(",", ", ")}` }),
        el("span", { className: "examples", textContent: c.examples.replaceAll(",", ", ") }),
      );
      b.onclick = () => setFilter({ view: "list", theme: String(c.id) });
      return el("li", {}, b);
    }),
  );
}

async function renderDuplicates() {
  const rows = await query("SELECT * FROM duplicates ORDER BY pair, side");
  const stale = new Date(Date.now() - 2 * 365 * 24 * 3600 * 1000).toISOString();
  const side = (d) => {
    const name = el("button", { type: "button", className: "linklike", textContent: d.full_name });
    name.onclick = async () => {
      const [repo] = await query("SELECT * FROM repos WHERE id = ?", [d.repo_id]);
      if (repo) openDetail(repo);
    };
    return el(
      "div",
      { className: "side" },
      name,
      d.description && el("span", { className: "desc", textContent: d.description }),
      el(
        "span",
        { className: "meta" },
        el("span", { textContent: `★ ${fmtNum(d.stars)}` }),
        el("span", { className: d.pushed_at < stale ? "stale" : "", textContent: `⟳ ${fmtDate(d.pushed_at)}` }),
        d.archived ? el("span", { className: "badge", textContent: "archivé" }) : null,
        d.fork ? el("span", { className: "badge", textContent: "fork" }) : null,
      ),
    );
  };
  const owner = (d) => d.full_name.split("/")[0].toLowerCase();
  const items = [];
  for (let i = 0; i < rows.length; i += 2) {
    if (!$("sameOwner").checked && rows[i + 1] && owner(rows[i]) === owner(rows[i + 1])) continue;
    items.push(
      el(
        "li",
        {},
        side(rows[i]),
        el("span", { className: "score", title: "similarité cosinus", textContent: `≈ ${rows[i].score.toFixed(2)}` }),
        rows[i + 1] && side(rows[i + 1]),
      ),
    );
  }
  $("duplicatesList").replaceChildren(...items);
  if (!items.length) $("duplicatesList").append(el("li", { className: "muted", textContent: "Aucun doublon détecté." }));
}

function readStateFromDom() {
  state.q = $("q").value;
  state.lang = $("lang").value;
  state.anyLang = $("anyLang").checked;
  state.topic = $("topic").value.trim();
  state.sort = $("sort").value;
  state.theme = $("theme").value;
  state.activity = $("activity").value;
  state.hideForks = $("hideForks").checked;
}

function onChange() {
  readStateFromDom();
  state.view = "list";
  writeState();
  refresh();
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
  refresh();
  loadThemes();

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
  for (const id of ["lang", "sort", "theme", "activity", "hideForks"]) $(id).addEventListener("change", onChange);
  $("sameOwner").addEventListener("change", () => renderDuplicates().catch(showError));
  for (const b of document.querySelectorAll("#views button")) b.onclick = () => setFilter({ view: b.dataset.view });
  $("reset").onclick = () => setFilter({ ...DEFAULTS });
  $("more").onclick = () => search(false);
  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && !$("more").hidden) search(false);
  }).observe($("more"));
  $("closeDetail").onclick = () => $("detail").close();
  $("detail").addEventListener("click", (ev) => ev.target === $("detail") && $("detail").close());
}

main().catch(showError);
