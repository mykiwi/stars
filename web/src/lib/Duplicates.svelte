<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { query } from './db.svelte.ts';
	import { fmtNum } from './format.ts';
	import RepoMeta from './RepoMeta.svelte';
	import type { Duplicate } from './types.ts';

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
	<div class="flex min-w-0 flex-col items-start gap-1">
		<Button
			variant="link"
			class="h-auto p-0 text-base font-semibold text-blue-600 [overflow-wrap:anywhere] whitespace-normal dark:text-blue-400"
			onclick={() => onopen(d.repo_id)}
		>
			{d.full_name}
		</Button>
		{#if d.description}<span>{d.description}</span>{/if}
		<span class="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
			<span>★ {fmtNum(d.stars)}</span>
			<RepoMeta {...d} staleBefore={stale} />
		</span>
	</div>
{/snippet}

<section>
	<div class="text-muted-foreground mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
		<p>
			Paires quasi identiques : souvent un projet abandonné et son fork maintenu. Compare l'activité pour choisir
			lequel garder.
		</p>
		<div class="flex items-center gap-2">
			<Checkbox id="sameOwner" bind:checked={sameOwner} />
			<Label for="sameOwner" class="font-normal">inclure les projets d'une même organisation</Label>
		</div>
	</div>
	<ol id="duplicates" class="grid gap-3">
		{#each pairs as [a, b] (a.pair)}
			<li>
				<Card.Root size="sm" class="grid grid-cols-1 items-start gap-4 px-4 md:grid-cols-[1fr_auto_1fr]">
					{@render side(a)}
					<span class="text-muted-foreground self-center" title="similarité cosinus">≈ {a.score.toFixed(2)}</span>
					{#if b}{@render side(b)}{/if}
				</Card.Root>
			</li>
		{:else}
			{#if rows}<li class="text-muted-foreground">Aucun doublon détecté.</li>{/if}
		{/each}
	</ol>
</section>
