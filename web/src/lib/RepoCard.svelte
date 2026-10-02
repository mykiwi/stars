<script lang="ts">
	import Chart from './Chart.svelte';
	import { fmtDate, fmtNum, highlight, historyTitle } from './format';
	import type { Point, Repo } from './types';

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

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<li
	class="repo"
	tabindex="0"
	onclick={() => onopen(repo)}
	onkeydown={(ev) => ev.key === 'Enter' && ev.target === ev.currentTarget && onopen(repo)}
>
	<div class="head">
		<h3>
			<a href={repo.url} target="_blank" rel="noopener" onclick={(ev) => ev.stopPropagation()}>
				{repo.full_name}
			</a>
		</h3>
		<span class="stars" title="{repo.stars} stars">
			{#if points}
				<span class="spark" title={historyTitle(points)}>
					<Chart {points} width={60} height={16} pad={1} />
				</span>
			{/if}
			★ {fmtNum(repo.stars)}
		</span>
	</div>
	{#if repo.description}<p class="desc">{repo.description}</p>{/if}
	{#if snippet}
		<p class="snippet">
			{#each highlight(snippet) as part}{#if part.mark}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}
		</p>
	{/if}
	<div class="meta">
		{#each langs as lang}
			<button type="button" class="lang" title="Filtrer sur {lang}" onclick={(ev) => pick(ev, () => onlang(lang))}>
				<span class="dot" style:background={colors.get(lang) || '#888'}></span>{lang}
			</button>
		{/each}
		{#if repo.license}<span>{repo.license}</span>{/if}
		{#if repo.archived}<span class="badge">archivé</span>{/if}
		{#if repo.fork}<span class="badge">fork</span>{/if}
		<span title="date de star">☆ {fmtDate(repo.starred_at)}</span>
		<span title="dernier push">⟳ {fmtDate(repo.pushed_at)}</span>
	</div>
	{#if topics.length}
		<div class="topics">
			{#each topics as topic}
				<button type="button" class="topic" onclick={(ev) => pick(ev, () => ontopic(topic))}>{topic}</button>
			{/each}
		</div>
	{/if}
</li>
