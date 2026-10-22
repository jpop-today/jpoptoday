import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

// Frontmatter mirrors contracts/artists.mjs, which reads the same files for robots/sitemap decisions.
const artists = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/artists' }),
  schema: z.object({ name: z.string().min(1), artists: z.array(z.string().min(1)).min(1), draft: z.boolean() }),
});

export const collections = { artists };
