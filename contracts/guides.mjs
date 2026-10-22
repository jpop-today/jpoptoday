/** Guides: markdown in src/content/guides, indexed only when published with a written body. */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { parseFrontmatter, projectRoot, SLUG } from './artists.mjs';

const TABLE_TYPES = ['artist', 'tags', 'songs', 'chart-new', 'coverage'];

export function parseGuide(slug, text) {
  if (!SLUG.test(slug)) throw new Error(`Invalid guide slug: ${slug}`);
  const { data, body } = parseFrontmatter(slug, text);
  for (const key of ['title', 'description'])
    if (typeof data[key] !== 'string' || !data[key].trim()) throw new Error(`${slug}: ${key} required`);
  if (typeof data.draft !== 'boolean') throw new Error(`${slug}: draft must be true or false`);
  if (data.table !== undefined && !TABLE_TYPES.includes(data.table?.type)) throw new Error(`${slug}: unknown table type`);
  // A published guide needs a person-written body; a data table alone is not a guide.
  const indexable = !data.draft && body.replace(/<!--[\s\S]*?-->/g, '').trim().length > 0;
  return { slug, title: data.title, description: data.description, editor: data.editor ?? 'jpop.today 편집',
    reviewedAt: data.reviewedAt ?? null, draft: data.draft, sources: data.sources ?? null, table: data.table ?? null, body, indexable };
}

export function loadGuides(directory = new URL('src/content/guides/', projectRoot)) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => name.endsWith('.md')).sort()
    .map(name => parseGuide(name.slice(0, -3), readFileSync(new URL(name, directory), 'utf8')));
}

/** Drafts are built only for preview (always noindex) so production never shows an empty guide. */
export const guidesForTarget = (guides, target) => target === 'production' ? guides.filter(guide => !guide.draft) : guides;
