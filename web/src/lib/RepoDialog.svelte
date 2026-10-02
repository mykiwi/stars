<script lang="ts">
	import Chart from './Chart.svelte';
	import { query } from './db';
	import { fmtDate, fmtDay, fmtInt, fmtNum } from './format';
	import { isMarkdown, renderReadme } from './markdown';
	import type { Point, Repo, Similar } from './types';

	interface Props {
		repo: Repo | null;
		onclose: () => void;
		onopen: (repoId: number) => void;
		ontheme: (themeId: string) => void;
	}

	interface Readme {
		kind: 'loading' | 'none' | 'html' | 'text' | 'error';
		content?: string;
	}

	let { repo, onclose, onopen, ontheme }: Props = $props();

	let dialog: HTMLDialogElement;
	let readme = $state.raw<Readme>({ kind: 'loading' });
	let similar = $state.raw<Similar[]>([]);
	let theme = $state.raw<{ id: number; label: string } | null>(null);
	// null: unknown yet, []: not backfilled (falls back to star-history.com's own chart)
	let history = $state.raw<Point[] | null>(null);
	let generation = 0;

	const meta = $derived(
		repo &&
			[
				`★ ${fmtInt(repo.stars)}`,
				repo.languages.replaceAll(',', ', '),
				repo.homepage,
				`star le ${fmtDate(repo.starred_at)}`
			]
				.filter(Boolean)
				.join(' · ')
	);

	$effect(() => {
		if (!repo) {
			if (dialog.open) dialog.close();
			return;
		}
		if (!dialog.open) dialog.showModal();
		dialog.scrollTop = 0;
		load(repo, ++generation);
	});

	// Tables added over time: older databases miss some of them.
	const optional = <T,>(rows: Promise<T[]>) => rows.catch(() => [] as T[]);

	function load(r: Repo, gen: number) {
		const current = () => gen === generation;
		readme = { kind: 'loading' };
		similar = [];
		theme = null;
		history = null;

		optional(query<Similar>('SELECT * FROM similar WHERE repo_id = ? ORDER BY rank', [r.id])).then(
			(rows) => current() && (similar = rows)
		);
		optional(
			query<{ id: number; label: string }>(
				'SELECT c.id, c.label FROM repo_clusters rc JOIN clusters c ON c.id = rc.cluster_id WHERE rc.repo_id = ?',
				[r.id]
			)
		).then((rows) => current() && (theme = rows[0] ?? null));
		query<{ points: string; backfilled: string | null }>(
			'SELECT points, backfilled FROM star_history WHERE repo_id = ?',
			[r.id]
		).then(
			([row]) => {
				if (!current()) return;
				const points: Point[] = row ? JSON.parse(row.points) : [];
				const backfilled = row?.backfilled && !row.backfilled.startsWith('failed:');
				history = backfilled && points.length >= 3 ? points : [];
			},
			() => {}
		);
		query<{ path: string; content: string }>('SELECT path, content FROM readmes WHERE repo_id = ?', [r.id]).then(
			([m]) => {
				if (!current()) return;
				if (!m) readme = { kind: 'none' };
				else if (isMarkdown(m.path))
					readme = { kind: 'html', content: renderReadme(r.full_name, m.path, m.content) };
				else readme = { kind: 'text', content: m.content };
			},
			(e) => current() && (readme = { kind: 'error', content: String(e) })
		);
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog id="detail" bind:this={dialog} {onclose} onclick={(ev) => ev.target === dialog && dialog.close()}>
	{#if repo}
		<article>
			<header>
				<div>
					<h2><a href={repo.url} target="_blank" rel="noopener">{repo.full_name}</a></h2>
					<p class="muted">{meta}</p>
					{#if theme}
						{@const id = String(theme.id)}
						<p id="detailTheme">
							Thème : <button type="button" class="topic" onclick={() => ontheme(id)}>{theme.label}</button>
						</p>
					{/if}
				</div>
				<!-- svelte-ignore a11y_autofocus -->
				<button id="closeDetail" type="button" aria-label="Fermer" autofocus onclick={() => dialog.close()}>✕</button>
			</header>
			{#if history}
				<section id="history">
					<h3>
						Évolution des stars
						<a href="https://www.star-history.com/#{repo.full_name}&Date" target="_blank" rel="noopener">
							détail sur star-history.com
						</a>
					</h3>
					{#if history.length}
						{@const [first, last] = [history[0], history[history.length - 1]]}
						<div id="historyChart"><Chart points={history} width={600} height={90} pad={3} /></div>
						<p class="axis muted">
							<span>{fmtDay(first[0])} · {fmtInt(first[1])} ★</span>
							<span>{fmtDay(last[0])} · {fmtInt(last[1])} ★</span>
						</p>
					{:else}
						<!-- Not backfilled yet: show star-history.com's own chart, loaded on demand. -->
						<div id="historyChart" class="external">
							<img
								loading="lazy"
								alt="Évolution des stars de {repo.full_name}"
								src="https://api.star-history.com/svg?{new URLSearchParams({ repos: repo.full_name, type: 'Date' })}"
							/>
						</div>
					{/if}
				</section>
			{/if}
			{#if similar.length}
				<section id="similar">
					<h3>Projets similaires</h3>
					<ol id="similarList">
						{#each similar as s (s.similar_id)}
							<li>
								<button type="button" title={s.description || ''} onclick={() => onopen(s.similar_id)}>
									<strong>{s.full_name}</strong>
									<span class="muted">★ {fmtNum(s.stars)}{s.language ? ` · ${s.language}` : ''}</span>
									{#if s.description}<span class="desc">{s.description}</span>{/if}
								</button>
							</li>
						{/each}
					</ol>
				</section>
			{/if}
			<div id="readme" class="markdown">
				{#if readme.kind === 'loading'}
					<p class="muted">Chargement du README…</p>
				{:else if readme.kind === 'none'}
					<p class="muted">Pas de README.</p>
				{:else if readme.kind === 'html'}
					{@html readme.content}
				{:else if readme.kind === 'text'}
					<pre>{readme.content}</pre>
				{:else}
					<p class="error">{readme.content}</p>
				{/if}
			</div>
		</article>
	{/if}
</dialog>
