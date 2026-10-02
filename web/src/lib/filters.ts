export const PAGE_SIZE = 50;

export const SORTS = {
	relevance: 'bm25(search, 10.0, 4.0, 4.0, 1.0)',
	starred: 'r.starred_at DESC',
	stars: 'r.stars DESC',
	pushed: 'r.pushed_at DESC',
	oldest: 'r.pushed_at ASC',
	name: 'r.full_name COLLATE NOCASE'
};

export const ACTIVITY = {
	active: "r.pushed_at >= date('now', '-1 year')",
	stale: "r.pushed_at < date('now', '-2 years')",
	archived: 'r.archived',
	live: 'NOT r.archived'
};

export const VIEWS = ['list', 'themes', 'duplicates'] as const;

export interface Filters {
	view: (typeof VIEWS)[number];
	q: string;
	lang: string;
	anyLang: boolean;
	theme: string;
	topic: string;
	sort: keyof typeof SORTS;
	activity: keyof typeof ACTIVITY | '';
	hideForks: boolean;
}

export const DEFAULTS: Filters = {
	view: 'list',
	q: '',
	lang: '',
	anyLang: false,
	theme: '',
	topic: '',
	sort: 'relevance',
	activity: '',
	hideForks: false
};

const oneOf = <T extends string>(value: string | null, allowed: readonly T[], fallback: T) =>
	allowed.includes(value as T) ? (value as T) : fallback;

export function parseFilters(p: Pick<URLSearchParams, 'get'>): Filters {
	return {
		view: oneOf(p.get('view'), VIEWS, DEFAULTS.view),
		q: p.get('q') ?? '',
		lang: p.get('lang') ?? '',
		anyLang: p.get('anyLang') === '1',
		theme: p.get('theme') ?? '',
		topic: p.get('topic') ?? '',
		sort: oneOf(p.get('sort'), Object.keys(SORTS) as Filters['sort'][], DEFAULTS.sort),
		activity: oneOf(p.get('activity'), Object.keys(ACTIVITY) as Filters['activity'][], ''),
		hideForks: p.get('hideForks') === '1'
	};
}

export function toQueryString(filters: Filters): string {
	const p = new URLSearchParams();
	for (const [k, v] of Object.entries(filters)) {
		if (v === DEFAULTS[k as keyof Filters]) continue;
		p.set(k, typeof v === 'boolean' ? '1' : v);
	}
	return p.toString();
}

export function ftsQuery(text: string): string {
	const terms = text.match(/[\p{L}\p{N}]+/gu) || [];
	return terms.map((t) => `"${t}"*`).join(' ');
}

export function buildWhere(filters: Filters) {
	const joins: string[] = [];
	const where: string[] = [];
	const params: unknown[] = [];
	const fts = ftsQuery(filters.q);
	if (fts) {
		joins.push('JOIN search ON search.rowid = r.id');
		where.push('search MATCH ?');
		params.push(fts);
	}
	if (filters.lang) {
		where.push(
			filters.anyLang
				? 'r.id IN (SELECT repo_id FROM repo_languages WHERE language = ?)'
				: 'r.language = ?'
		);
		params.push(filters.lang);
	}
	if (filters.topic) {
		where.push('r.id IN (SELECT repo_id FROM repo_topics WHERE topic = ?)');
		params.push(filters.topic.trim().toLowerCase());
	}
	if (filters.theme) {
		where.push('r.id IN (SELECT repo_id FROM repo_clusters WHERE cluster_id = ?)');
		params.push(Number(filters.theme));
	}
	if (filters.activity) where.push(ACTIVITY[filters.activity]);
	if (filters.hideForks) where.push('NOT r.fork');
	return {
		fts,
		from: `FROM repos r ${joins.join(' ')}`,
		where: where.length ? `WHERE ${where.join(' AND ')}` : '',
		params,
		sort: filters.sort === 'relevance' && !fts ? SORTS.starred : SORTS[filters.sort]
	};
}
