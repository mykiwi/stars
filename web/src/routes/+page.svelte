<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { openDb, query, stats, type DbInfo } from '#lib/db.ts';
	import Duplicates from '#lib/Duplicates.svelte';
	import {
		buildWhere,
		DEFAULTS,
		PAGE_SIZE,
		parseFilters,
		toQueryString,
		type Filters
	} from '#lib/filters.ts';
	import { fmtDate, fmtInt, HL_END, HL_START } from '#lib/format.ts';
	import RepoCard from '#lib/RepoCard.svelte';
	import RepoDialog from '#lib/RepoDialog.svelte';
	import Themes from '#lib/Themes.svelte';
	import type { Cluster, Facet, Point, Repo } from '#lib/types.ts';

	// The URL is the source of truth for filters.
	const filters = $derived(parseFilters(page.url.searchParams));
	const anyLang = $derived(filters.anyLang);

	let ready = $state(false);
	let error = $state('');
	let dbInfo = $state.raw<DbInfo | null>(null);
	let meta = $state.raw<Record<string, string>>({});
	let colors = $state.raw(new Map<string, string>());
	let languages = $state.raw<Facet[]>([]);
	let themes = $state.raw<Pick<Cluster, 'id' | 'label' | 'size'>[]>([]);
	let topics = $state.raw<Facet[] | null>(null);

	let rows = $state.raw<Repo[]>([]);
	let total = $state<number | null>(null);
	let sparks = $state.raw<Record<number, Point[]>>({});
	let snippets = $state.raw<Record<number, string>>({});
	let selected = $state.raw<Repo | null>(null);

	let q = $state('');
	let committedQ = '';
	let timer: ReturnType<typeof setTimeout>;
	let pageNo = 0;
	let generation = 0;
	let loadingMore = false;

	const repoCount = $derived(Number(meta.count));
	const hasMore = $derived(filters.view === 'list' && total !== null && rows.length < total);

	function showError(e: unknown) {
		console.error(e);
		error = `Erreur : ${e instanceof Error ? e.message : e}`;
	}

	function update(patch: Partial<Filters>) {
		const qs = toQueryString({ ...filters, ...patch });
		return goto(qs ? `?${qs}` : page.url.pathname, { replace: true, reset: false });
	}

	// Form controls always bring back to the list.
	const change = (patch: Partial<Filters>) => update({ ...patch, view: 'list' });

	async function setFilter(patch: Partial<Filters>) {
		await update(patch);
		scrollTo({ top: 0 });
	}

	function onSearchInput() {
		clearTimeout(timer);
		timer = setTimeout(() => {
			committedQ = q;
			change({ q });
		}, 250);
	}

	async function search(f: Filters, reset: boolean) {
		if (!reset) {
			if (loadingMore) return;
			loadingMore = true;
		}
		const gen = reset ? ++generation : generation;
		if (reset) pageNo = 0;
		const { fts, from, where, params, sort } = buildWhere(f);
		try {
			let count = total;
			if (reset) {
				total = null;
				count = where
					? (await query<{ n: number }>(`SELECT COUNT(*) AS n ${from} ${where}`, params))[0].n
					: repoCount;
				if (gen !== generation) return;
			}
			const found = await query<Repo>(
				`SELECT r.* ${from} ${where} ORDER BY ${sort}, r.id LIMIT ${PAGE_SIZE} OFFSET ${pageNo * PAGE_SIZE}`,
				params
			);
			if (gen !== generation) return;
			if (reset) [sparks, snippets] = [{}, {}];
			rows = reset ? found : [...rows, ...found];
			total = count;
			pageNo++;
			error = '';
			// Snippets read whole READMEs over HTTP: only for the top results, skipping huge ones.
			const snippetIds = found
				.filter((r) => r.readme_size && r.readme_size < 65536)
				.slice(0, 10)
				.map((r) => r.id);
			if (fts && reset && snippetIds.length) loadSnippets(gen, fts, snippetIds);
			loadSparklines(
				gen,
				found.map((r) => r.id)
			);
		} catch (e) {
			showError(e);
		} finally {
			if (!reset) loadingMore = false;
		}
	}

	const placeholders = (ids: number[]) => ids.map(() => '?').join(',');

	async function loadSparklines(gen: number, ids: number[]) {
		if (!ids.length) return;
		let found: { repo_id: number; points: string }[];
		try {
			found = await query(`SELECT repo_id, points FROM star_history WHERE repo_id IN (${placeholders(ids)})`, ids);
		} catch {
			return; // database built before star history existed
		}
		if (gen !== generation) return;
		const parsed = found.map((r) => [r.repo_id, JSON.parse(r.points) as Point[]] as const);
		sparks = { ...sparks, ...Object.fromEntries(parsed.filter(([, pts]) => pts.length >= 3)) };
	}

	async function loadSnippets(gen: number, fts: string, ids: number[]) {
		const found = await query<{ id: number; s: string | null }>(
			`SELECT rowid AS id, snippet(search, 3, ?, ?, '…', 24) AS s FROM search
			 WHERE search MATCH ? AND rowid IN (${placeholders(ids)})`,
			[HL_START, HL_END, fts, ...ids]
		);
		if (gen !== generation) return;
		snippets = Object.fromEntries(found.filter((r) => r.s?.includes(HL_START)).map((r) => [r.id, r.s!]));
	}

	async function openById(id: number) {
		const [repo] = await query<Repo>('SELECT * FROM repos WHERE id = ?', [id]);
		if (repo) selected = repo;
	}

	async function loadTopics() {
		if (topics) return;
		topics = [];
		topics = await query<Facet>(
			"SELECT name, count AS n FROM facets WHERE kind = 'topic' ORDER BY count DESC LIMIT 1000"
		);
	}

	function autoload(node: HTMLElement) {
		const observer = new IntersectionObserver(
			(entries) => entries[0].isIntersecting && search(filters, false)
		);
		observer.observe(node);
		return () => observer.disconnect();
	}

	onMount(async () => {
		try {
			dbInfo = await openDb();
			Object.assign(window, { stats });
			const m = await query<{ key: string; value: string }>('SELECT key, value FROM meta');
			const l = await query<{ name: string; color: string }>('SELECT name, color FROM languages');
			meta = Object.fromEntries(m.map((r) => [r.key, r.value]));
			colors = new Map(l.map((r) => [r.name, r.color]));
			ready = true;
			// Database built before themes existed: keep the filter empty.
			themes = await query<Cluster>('SELECT id, label, size FROM clusters ORDER BY label').catch(() => []);
		} catch (e) {
			showError(e);
		}
	});

	$effect(() => {
		if (filters.q !== committedQ) q = committedQ = filters.q;
	});

	$effect(() => {
		if (!ready) return;
		query<Facet>('SELECT name, count AS n FROM facets WHERE kind = ? ORDER BY count DESC, name', [
			anyLang ? 'any_language' : 'language'
		]).then((found) => (languages = found), showError);
	});

	$effect(() => {
		if (!ready) return;
		const f = filters;
		untrack(() => {
			if (f.view === 'list') search(f, true);
			else generation++; // drop in-flight list results
		});
	});
</script>

<svelte:head>
	<title>{meta.login ? `Stars de @${meta.login}` : 'Stars'}</title>
</svelte:head>

<header id="top">
	<div class="title">
		<h1>★ Stars</h1>
		<span class="muted">
			{#if ready}
				{fmtInt(repoCount)} stars de @{meta.login} · màj {fmtDate(meta.fetched_at)}
			{:else}
				Chargement de la base…
			{/if}
		</span>
		<nav id="views">
			{#each [['list', 'Liste'], ['themes', 'Thèmes'], ['duplicates', 'Doublons']] as const as [view, label]}
				<button type="button" class={{ active: filters.view === view }} onclick={() => setFilter({ view })}>
					{label}
				</button>
			{/each}
		</nav>
		{#if dbInfo}
			<a id="download" href={dbInfo.url} download="stars.sqlite">
				Télécharger la base SQLite ({(dbInfo.size / 1e6).toFixed(0)} Mo)
			</a>
		{/if}
	</div>
	<form autocomplete="off" onsubmit={(ev) => ev.preventDefault()}>
		<!-- svelte-ignore a11y_autofocus -->
		<input
			id="q"
			type="search"
			placeholder="Rechercher (nom, description, topics, README)…"
			autofocus
			bind:value={q}
			oninput={onSearchInput}
		/>
		<div class="row">
			<label>
				Langage
				<select id="lang" onchange={(ev) => change({ lang: ev.currentTarget.value })}>
					<option value="" selected={!filters.lang}>Tous</option>
					{#each languages as l (l.name)}
						<option value={l.name} selected={l.name === filters.lang}>{l.name} ({l.n})</option>
					{/each}
					{#if filters.lang && !languages.some((l) => l.name === filters.lang)}
						<option value={filters.lang} selected>{filters.lang}</option>
					{/if}
				</select>
			</label>
			<label title="Filtrer sur le langage principal ou sur tous les langages du repo">
				<input
					type="checkbox"
					checked={filters.anyLang}
					onchange={(ev) => change({ anyLang: ev.currentTarget.checked })}
				/> tous langages
			</label>
			<label>
				Thème
				<select id="theme" onchange={(ev) => change({ theme: ev.currentTarget.value })}>
					<option value="" selected={!filters.theme}>Tous</option>
					{#each themes as c (c.id)}
						<option value={String(c.id)} selected={String(c.id) === filters.theme}>{c.label} ({c.size})</option>
					{/each}
				</select>
			</label>
			<label>
				Topic
				<input
					id="topic"
					list="topics"
					placeholder="tous"
					value={filters.topic}
					onfocus={loadTopics}
					onchange={(ev) => change({ topic: ev.currentTarget.value.trim() })}
				/>
				<datalist id="topics">
					{#each topics ?? [] as t (t.name)}
						<option value={t.name} label="{t.name} ({t.n})"></option>
					{/each}
				</datalist>
			</label>
			<label>
				Tri
				<select value={filters.sort} onchange={(ev) => change({ sort: ev.currentTarget.value as Filters['sort'] })}>
					<option value="relevance">Pertinence</option>
					<option value="starred">Date de star</option>
					<option value="stars">Nombre de stars</option>
					<option value="pushed">Activité récente</option>
					<option value="oldest">Activité la plus ancienne</option>
					<option value="name">Nom</option>
				</select>
			</label>
			<label>
				État
				<select
					value={filters.activity}
					onchange={(ev) => change({ activity: ev.currentTarget.value as Filters['activity'] })}
				>
					<option value="">Tous</option>
					<option value="active">Actifs (push &lt; 1 an)</option>
					<option value="stale">Inactifs (pas de push depuis 2 ans)</option>
					<option value="archived">Archivés</option>
					<option value="live">Non archivés</option>
				</select>
			</label>
			<label>
				<input
					type="checkbox"
					checked={filters.hideForks}
					onchange={(ev) => change({ hideForks: ev.currentTarget.checked })}
				/> sans forks
			</label>
			<button type="button" onclick={() => setFilter({ ...DEFAULTS })}>Réinitialiser</button>
		</div>
	</form>
</header>

<main>
	{#if ready}
		{#if filters.view === 'themes'}
			<Themes onpick={(theme) => setFilter({ view: 'list', theme })} onerror={showError} />
		{:else if filters.view === 'duplicates'}
			<Duplicates onopen={openById} onerror={showError} />
		{:else}
			<p class="muted">
				{#if total === null}Recherche…{:else}{fmtInt(total)} repo{total > 1 ? 's' : ''}{/if}
			</p>
			<ol id="results">
				{#each rows as repo (repo.id)}
					<RepoCard
						{repo}
						{colors}
						points={sparks[repo.id]}
						snippet={snippets[repo.id]}
						onopen={(r) => (selected = r)}
						onlang={(lang) => setFilter({ lang })}
						ontopic={(topic) => setFilter({ topic })}
					/>
				{/each}
			</ol>
			{#if hasMore}
				<button id="more" type="button" onclick={() => search(filters, false)} {@attach autoload}>
					Plus de résultats
				</button>
			{/if}
		{/if}
	{/if}
	{#if error}<p class="error">{error}</p>{/if}
</main>

<RepoDialog
	repo={selected}
	onclose={() => (selected = null)}
	onopen={openById}
	ontheme={(theme) => {
		selected = null;
		setFilter({ view: 'list', theme });
	}}
/>
