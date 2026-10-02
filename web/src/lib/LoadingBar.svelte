<script lang="ts">
	let { active }: { active: boolean } = $props();
</script>

<!-- Indeterminate: the worker fetches database pages on demand, their number is not known in advance. -->
<div
	role="progressbar"
	aria-label="Lecture de la base"
	aria-busy={active}
	class={[
		'bg-primary/15 pointer-events-none fixed inset-x-0 top-0 z-50 h-1 overflow-hidden transition-opacity duration-300',
		active ? 'opacity-100' : 'opacity-0'
	]}
>
	<div class="bg-chart-2 animate-indeterminate h-full w-2/5 rounded-full"></div>
</div>
