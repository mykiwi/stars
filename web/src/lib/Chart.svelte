<script lang="ts">
	import type { Point } from './types';

	let { points, width, height, pad }: { points: Point[]; width: number; height: number; pad: number } =
		$props();

	const d = $derived.by(() => {
		const xs = points.map((p) => p[0]);
		const ys = points.map((p) => p[1]);
		const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
		const sx = (v: number) => pad + (x1 === x0 ? 0 : ((v - x0) / (x1 - x0)) * (width - 2 * pad));
		const sy = (v: number) =>
			height - pad - (y1 === y0 ? 0 : ((v - y0) / (y1 - y0)) * (height - 2 * pad));
		return points
			.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)} ${sy(p[1]).toFixed(1)}`)
			.join('');
	});
</script>

<svg viewBox="0 0 {width} {height}" preserveAspectRatio="none">
	<path {d} vector-effect="non-scaling-stroke" />
</svg>
