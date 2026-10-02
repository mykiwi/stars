import type { Point } from './types';

export const HL_START = '\u0002';
export const HL_END = '\u0003';

const DAY_MS = 86400000;

export const fmtInt = (n: number) => n.toLocaleString('fr');
export const fmtNum = (n: number) =>
	n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
export const fmtSize = (bytes: number) =>
	`${(bytes / 1e6).toLocaleString('fr', { maximumFractionDigits: bytes < 1e7 ? 1 : 0 })} Mo`;
export const fmtDate = (s: string | null) => (s ? s.slice(0, 10) : '?');
export const fmtDay = (d: number) => new Date(d * DAY_MS).toISOString().slice(0, 10);

export function historyTitle(points: Point[]): string {
	const [first, last] = [points[0], points[points.length - 1]];
	return `${fmtInt(first[1])} stars le ${fmtDay(first[0])} → ${fmtInt(last[1])} le ${fmtDay(last[0])}`;
}

// Snippets come from raw README source: drop HTML tags and markdown punctuation.
function cleanSnippet(text: string): string {
	return text
		.replace(/<!--|-->/g, ' ')
		.replace(/<\/?[a-z][^<>]*>?/gi, ' ')
		.replace(/!?\[([^\]]*)\]\([^)\s]*\)?/g, '$1')
		.replace(/[*`#>|~]+|={3,}|-{3,}/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

export interface SnippetPart {
	text: string;
	mark: boolean;
}

export function highlight(text: string): SnippetPart[] {
	const out: SnippetPart[] = [];
	let buf = '';
	let mark = false;
	const flush = () => {
		if (buf) out.push({ text: buf, mark });
		buf = '';
	};
	for (const ch of cleanSnippet(text)) {
		if (ch === HL_START || ch === HL_END) {
			flush();
			mark = ch === HL_START;
		} else {
			buf += ch;
		}
	}
	flush();
	return out;
}
