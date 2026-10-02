<script lang="ts">
	import * as Card from '#lib/components/ui/card/index.js';
	import { query } from './db.ts';
	import type { Cluster } from './types.ts';

	let { onpick, onerror }: { onpick: (themeId: string) => void; onerror: (e: unknown) => void } = $props();

	let clusters = $state.raw<Cluster[]>([]);

	$effect(() => {
		query<Cluster>('SELECT * FROM clusters ORDER BY size DESC').then((rows) => (clusters = rows), onerror);
	});
</script>

<section>
	<p class="text-muted-foreground mb-3 text-sm">
		Regroupements automatiques de tes stars par proximité sémantique (README, description, topics).
	</p>
	<ol id="themes" class="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
		{#each clusters as c (c.id)}
			<li>
				<button type="button" class="size-full cursor-pointer text-left" onclick={() => onpick(String(c.id))}>
					<Card.Root size="sm" class="hover:ring-primary h-full">
						<Card.Header>
							<Card.Title class="text-blue-600 dark:text-blue-400">{c.label}</Card.Title>
							<Card.Description class="text-xs">{c.size} repos · {c.languages.replaceAll(',', ', ')}</Card.Description>
						</Card.Header>
						<Card.Content class="text-xs">{c.examples.replaceAll(',', ', ')}</Card.Content>
					</Card.Root>
				</button>
			</li>
		{/each}
	</ol>
</section>
