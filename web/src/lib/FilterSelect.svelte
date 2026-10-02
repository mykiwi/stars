<script lang="ts">
	import * as Select from '#lib/components/ui/select/index.js';

	interface Props {
		id: string;
		value: string;
		options: { value: string; label: string }[];
		onchange: (value: string) => void;
		class?: string;
	}

	let { id, value, options, onchange, class: className }: Props = $props();

	// The select treats an empty value as "nothing selected": give "all" a real one.
	const ALL = '__all';
	const label = $derived(options.find((o) => o.value === value)?.label ?? value);
</script>

<Select.Root type="single" value={value || ALL} onValueChange={(v) => onchange(v === ALL ? '' : v)}>
	<Select.Trigger {id} size="sm" class={className}>
		<span class="truncate">{label}</span>
	</Select.Trigger>
	<Select.Content>
		{#each options as o (o.value)}
			<Select.Item value={o.value || ALL} label={o.label} />
		{/each}
	</Select.Content>
</Select.Root>
