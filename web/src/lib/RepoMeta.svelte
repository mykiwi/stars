<script lang="ts">
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { fmtDate } from './format.ts';

	let {
		pushed_at,
		archived,
		fork,
		staleBefore
	}: { pushed_at: string | null; archived: number; fork: number; staleBefore?: string } = $props();
</script>

{#if archived}<Badge variant="outline">archivé</Badge>{/if}
{#if fork}<Badge variant="outline">fork</Badge>{/if}
<span
	title="dernier push"
	class={{ 'text-destructive': staleBefore !== undefined && pushed_at !== null && pushed_at < staleBefore }}
>
	⟳ {fmtDate(pushed_at)}
</span>
