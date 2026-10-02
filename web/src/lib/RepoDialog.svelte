<script lang="ts">
	import { badgeVariants } from '#lib/components/ui/badge/index.js';
	import XIcon from '@lucide/svelte/icons/x';
	import { buttonVariants } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import Chart from './Chart.svelte';
	import { query } from './db.svelte.ts';
	import { fmtDate, fmtDay, fmtInt, fmtNum } from './format.ts';
	import { isMarkdown, renderReadme } from './markdown.ts';
	import type { Point, Repo, Similar } from './types.ts';

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

	let content = $state<HTMLElement | null>(null);
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
		if (!repo) return;
		if (content) content.scrollTop = 0;
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

<Dialog.Root open={repo !== null} onOpenChange={(open) => !open && onclose()}>
	<Dialog.Content
		bind:ref={content}
		class="block max-h-[92vh] overflow-y-auto p-0 sm:max-w-4xl"
		showCloseButton={false}
	>
		{#if repo}
			<Dialog.Header class="bg-popover sticky top-0 z-10 flex-row justify-between gap-4 border-b px-5 py-3">
				<div class="grid gap-1">
					<Dialog.Title class="text-lg">
						<a href={repo.url} target="_blank" rel="noopener" class="text-blue-600 hover:underline dark:text-blue-400">
							{repo.full_name}
						</a>
					</Dialog.Title>
					<Dialog.Description class="[overflow-wrap:anywhere]">{meta}</Dialog.Description>
					{#if theme}
						{@const id = String(theme.id)}
						<p class="text-muted-foreground">
							Thème :
							<button
								type="button"
								class={[badgeVariants({ variant: 'secondary' }), 'hover:bg-primary hover:text-primary-foreground cursor-pointer']}
								data-theme
								onclick={() => ontheme(id)}
							>
								{theme.label}
							</button>
						</p>
					{/if}
				</div>
				<Dialog.Close class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })} aria-label="Fermer">
					<XIcon />
				</Dialog.Close>
			</Dialog.Header>
			{#if history}
				<section class="px-5 pt-3" data-history>
					<h3 class="text-muted-foreground mb-2 font-semibold">
						Évolution des stars
						<a
							href="https://www.star-history.com/#{repo.full_name}&Date"
							target="_blank"
							rel="noopener"
							class="ml-2 text-xs font-normal text-blue-600 hover:underline dark:text-blue-400"
						>
							détail sur star-history.com
						</a>
					</h3>
					{#if history.length}
						{@const [first, last] = [history[0], history[history.length - 1]]}
						<div class="h-[90px]"><Chart points={history} width={600} height={90} pad={3} /></div>
						<p class="text-muted-foreground mt-1 flex justify-between text-xs">
							<span>{fmtDay(first[0])} · {fmtInt(first[1])} ★</span>
							<span>{fmtDay(last[0])} · {fmtInt(last[1])} ★</span>
						</p>
					{:else}
						<!-- Not backfilled yet: show star-history.com's own chart, loaded on demand. -->
						<img
							class="mx-auto block w-full max-w-[560px] rounded-md"
							loading="lazy"
							alt="Évolution des stars de {repo.full_name}"
							src="https://api.star-history.com/svg?{new URLSearchParams({ repos: repo.full_name, type: 'Date' })}"
						/>
					{/if}
				</section>
			{/if}
			{#if similar.length}
				<section class="px-5 pt-3">
					<h3 class="text-muted-foreground mb-2 font-semibold">Projets similaires</h3>
					<ol class="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2" data-similar>
						{#each similar as s (s.similar_id)}
							<li>
								<button
									type="button"
									class="bg-muted/50 hover:border-primary flex size-full cursor-pointer flex-col gap-0.5 rounded-lg border px-2.5 py-1.5 text-left text-xs"
									title={s.description || ''}
									onclick={() => onopen(s.similar_id)}
								>
									<strong class="text-blue-600 [overflow-wrap:anywhere] dark:text-blue-400">{s.full_name}</strong>
									<span class="text-muted-foreground">★ {fmtNum(s.stars)}{s.language ? ` · ${s.language}` : ''}</span>
									{#if s.description}<span class="line-clamp-2">{s.description}</span>{/if}
								</button>
							</li>
						{/each}
					</ol>
				</section>
			{/if}
			<div class="prose prose-sm dark:prose-invert prose-a:text-blue-600 dark:prose-a:text-blue-400 prose-code:before:content-none prose-code:after:content-none max-w-none px-5 py-4 [overflow-wrap:anywhere]" data-readme={readme.kind}>
				{#if readme.kind === 'loading'}
					<div class="grid gap-2"><Skeleton class="h-6 w-1/3" /><Skeleton class="h-4" /><Skeleton class="h-4 w-4/5" /></div>
				{:else if readme.kind === 'none'}
					<p class="text-muted-foreground">Pas de README.</p>
				{:else if readme.kind === 'html'}
					{@html readme.content}
				{:else if readme.kind === 'text'}
					<pre class="whitespace-pre-wrap">{readme.content}</pre>
				{:else}
					<p class="text-destructive">{readme.content}</p>
				{/if}
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>
