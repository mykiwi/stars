export interface Repo {
	id: number;
	full_name: string;
	url: string;
	description: string | null;
	homepage: string | null;
	language: string | null;
	languages: string;
	topics: string;
	license: string | null;
	stars: number;
	archived: number;
	fork: number;
	pushed_at: string | null;
	starred_at: string;
	readme_size: number;
}

export interface Similar {
	similar_id: number;
	full_name: string;
	description: string | null;
	language: string | null;
	stars: number;
}

export interface Duplicate {
	pair: number;
	score: number;
	repo_id: number;
	full_name: string;
	description: string | null;
	stars: number;
	pushed_at: string | null;
	archived: number;
	fork: number;
}

export interface Cluster {
	id: number;
	label: string;
	size: number;
	languages: string;
	examples: string;
}

export interface Facet {
	name: string;
	n: number;
}

/** [days since epoch, stars] */
export type Point = [number, number];
