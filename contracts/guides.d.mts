export type GuideTable =
  | { type: 'artist'; slug: string }
  | { type: 'tags'; tags: string[]; limit?: number }
  | { type: 'songs'; ids: string[] }
  | { type: 'chart-new'; month: string }
  | { type: 'coverage' };
export type GuideSource = { label: string; url: string; checkedAt: string };
export type Guide = { slug: string; title: string; description: string; editor: string; reviewedAt: string | null;
  draft: boolean; sources: GuideSource[] | null; table: GuideTable | null; body: string; indexable: boolean };
export function parseGuide(slug: string, text: string): Guide;
export function loadGuides(directory?: URL): Guide[];
export function guidesForTarget(guides: Guide[], target: string): Guide[];
