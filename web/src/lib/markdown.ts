import DOMPurify from 'dompurify';
import { marked } from 'marked';

interface Base {
	raw: string;
	blob: string;
	root: string;
}

let base: Base | null = null;

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
	const current = base;
	if (!current) return;
	const rewrite = (attr: string, to: string) => {
		const v = node.getAttribute(attr);
		if (!v || v.startsWith('#') || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(v)) return;
		try {
			node.setAttribute(attr, new URL(v.replace(/^\//, ''), v.startsWith('/') ? current.root : to).href);
		} catch {}
	};
	if (node.tagName === 'IMG') rewrite('src', current.raw);
	if (node.tagName === 'A') {
		rewrite('href', current.blob);
		if (!node.getAttribute('href')?.startsWith('#')) {
			node.setAttribute('target', '_blank');
			node.setAttribute('rel', 'noopener noreferrer');
		}
	}
});

export const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path) || !path.includes('.');

/** Sanitized HTML of a README, with relative links and images pointing at GitHub. */
export function renderReadme(fullName: string, path: string, content: string): string {
	const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
	base = {
		raw: `https://raw.githubusercontent.com/${fullName}/HEAD/${dir}`,
		blob: `https://github.com/${fullName}/blob/HEAD/${dir}`,
		root: `https://github.com/${fullName}/blob/HEAD/`
	};
	try {
		return DOMPurify.sanitize(marked.parse(content, { gfm: true, async: false }));
	} finally {
		base = null;
	}
}
