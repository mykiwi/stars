<script lang="ts">
	import { query } from './db';
	import { fmtDate, fmtNum } from './format';
	import type { Duplicate } from './types';

	let { onopen, onerror }: { onopen: (repoId: number) => void; onerror: (e: unknown) => void } = $props();

	let rows = $state.raw<Duplicate[] | null>(null);
	let sameOwner = $state(false);

	const stale = new Date(Date.now() - 2 * 365 * 24 * 3600 * 1000).toISOString();
	const owner = (d: Duplicate) => d.full_name.split('/')[0].toLowerCase();
	const pairs = $derived.by(() => {
		const out: Duplicate[][] = [];
		for (let i = 0; i < (rows?.length ?? 0); i += 2) {
			const pair = rows!.slice(i, i + 2);
			if (!sameOwner && pair[1] && owner(pair[0]) === owner(pair[1])) continue;
			out.push(pair);
		}
		return out;
	});

	$effect(() => {
		query<Duplicate>('SELECT * FROM duplicates ORDER BY pair, side').then((r) => (rows = r), onerror);
	});
</script>

{#snippet side(d: Duplicate)}
	<div class="side">
		<button type="button" class="linklike" onclick={() => onopen(d.repo_id)}>{d.full_name}</button>
		{#if d.description}<span class="desc">{d.description}</span>{/if}
		<span class="meta">
			<span>★ {fmtNum(d.stars)}</span>
			<span class={{ stale: d.pushed_at !== null && d.pushed_at < stale }}>⟳ {fmtDate(d.pushed_at)}</span>
			{#if d.archived}<span class="badge">archivé</span>{/if}
			{#if d.fork}<span class="badge">fork</span>{/if}
		</span>
	</div>
{/snippet}

<section id="duplicatesView">
	<p class="muted">
		Paires quasi identiques : souvent un projet abandonné et son fork maintenu. Compare l'activité pour choisir
		lequel garder.
		<label><input type="checkbox" bind:checked={sameOwner} /> inclure les projets d'une même organisation</label>
	</p>
	<ol id="duplicatesList">
		{#each pairs as [a, b] (a.pair)}
			<li>
				{@render side(a)}
				<span class="score" title="similarité cosinus">≈ {a.score.toFixed(2)}</span>
				{#if b}{@render side(b)}{/if}
			</li>
		{:else}
			{#if rows}<li class="muted">Aucun doublon détecté.</li>{/if}
		{/each}
	</ol>
</section>
