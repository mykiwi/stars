<script lang="ts">
	import { query } from './db';
	import type { Cluster } from './types';

	let { onpick, onerror }: { onpick: (themeId: string) => void; onerror: (e: unknown) => void } = $props();

	let clusters = $state.raw<Cluster[]>([]);

	$effect(() => {
		query<Cluster>('SELECT * FROM clusters ORDER BY size DESC').then((rows) => (clusters = rows), onerror);
	});
</script>

<section id="themesView">
	<p class="muted">Regroupements automatiques de tes stars par proximité sémantique (README, description, topics).</p>
	<ol id="themesList">
		{#each clusters as c (c.id)}
			<li>
				<button type="button" onclick={() => onpick(String(c.id))}>
					<strong>{c.label}</strong>
					<span class="muted">{c.size} repos · {c.languages.replaceAll(',', ', ')}</span>
					<span class="examples">{c.examples.replaceAll(',', ', ')}</span>
				</button>
			</li>
		{/each}
	</ol>
</section>
