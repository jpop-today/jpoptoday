import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

// Frontmatter mirrors contracts/artists.mjs, which reads the same files for robots/sitemap decisions.
const artists = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/artists' }),
  schema: z.object({ name: z.string().min(1), artists: z.array(z.string().min(1)).min(1), draft: z.boolean() }),
});

// Same frontmatter rules as contracts/guides.mjs; table specs are validated there.
const guides = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/guides' }),
  schema: z.object({ title: z.string().min(1), description: z.string().min(1), draft: z.boolean(),
    editor: z.string().optional(), reviewedAt: z.string().optional(),
    sources: z.array(z.object({ label: z.string(), url: z.string(), checkedAt: z.string() })).optional(),
    table: z.record(z.string(), z.unknown()).optional() }),
});

export const collections = { artists, guides };
