<script lang="ts">
	import { badgeVariants } from '#lib/components/ui/badge/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import Chart from './Chart.svelte';
	import { fmtDate, fmtNum, highlight, historyTitle } from './format.ts';
	import RepoMeta from './RepoMeta.svelte';
	import type { Point, Repo } from './types.ts';

	interface Props {
		repo: Repo;
		colors: Map<string, string>;
		points?: Point[];
		snippet?: string;
		onopen: (repo: Repo) => void;
		onlang: (lang: string) => void;
		ontopic: (topic: string) => void;
	}

	let { repo, colors, points, snippet, onopen, onlang, ontopic }: Props = $props();

	const langs = $derived(repo.languages ? repo.languages.split(',').slice(0, 4) : []);
	const topics = $derived(repo.topics ? repo.topics.split(' ') : []);
	const pick = (ev: MouseEvent, fn: () => void) => {
		ev.stopPropagation();
		fn();
	};
</script>

<li>
	<Card.Root
		size="sm"
		role="button"
		tabindex={0}
		data-repo={repo.full_name}
		class="hover:ring-primary focus-visible:ring-primary cursor-pointer gap-1.5 px-4 outline-none"
		onclick={() => onopen(repo)}
		onkeydown={(ev) => ev.key === 'Enter' && ev.target === ev.currentTarget && onopen(repo)}
	>
		<div class="flex justify-between gap-4">
			<h3 class="text-base font-semibold [overflow-wrap:anywhere]">
				<a
					href={repo.url}
					target="_blank"
					rel="noopener"
					class="text-blue-600 hover:underline dark:text-blue-400"
					onclick={(ev) => ev.stopPropagation()}
				>
					{repo.full_name}
				</a>
			</h3>
			<span class="text-muted-foreground inline-flex items-center gap-1.5 whitespace-nowrap" title="{repo.stars} stars">
				{#if points}
					<span class="inline-block h-4 w-[60px]" title={historyTitle(points)} data-spark>
						<Chart {points} width={60} height={16} pad={1} />
					</span>
				{/if}
				★ {fmtNum(repo.stars)}
			</span>
		</div>
		{#if repo.description}<p>{repo.description}</p>{/if}
		{#if snippet}
			<p class="text-muted-foreground text-xs" data-snippet>
				{#each highlight(snippet) as part}{#if part.mark}<mark
							class="rounded-xs bg-yellow-200 text-inherit dark:bg-yellow-700/60">{part.text}</mark
						>{:else}{part.text}{/if}{/each}
			</p>
		{/if}
		<div class="text-muted-foreground flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs">
			{#each langs as lang}
				<button
					type="button"
					class="hover:text-foreground inline-flex cursor-pointer items-center gap-1"
					title="Filtrer sur {lang}"
					data-lang
					onclick={(ev) => pick(ev, () => onlang(lang))}
				>
					<span class="size-2.5 rounded-full" style:background={colors.get(lang) || '#888'}></span>{lang}
				</button>
			{/each}
			{#if repo.license}<span>{repo.license}</span>{/if}
			<span title="date de star">☆ {fmtDate(repo.starred_at)}</span>
			<RepoMeta {...repo} />
		</div>
		{#if topics.length}
			<div class="flex flex-wrap gap-1">
				{#each topics as topic}
					<button
						type="button"
						class={[badgeVariants({ variant: 'secondary' }), 'hover:bg-primary hover:text-primary-foreground cursor-pointer']}
						onclick={(ev) => pick(ev, () => ontopic(topic))}
					>
						{topic}
					</button>
				{/each}
			</div>
		{/if}
	</Card.Root>
</li>
