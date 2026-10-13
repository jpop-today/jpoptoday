import { defineConfig } from 'astro/config';
export default defineConfig({ site: 'https://jpop.today', output: 'static', trailingSlash: 'always', build: { format: 'directory' }, devToolbar: { enabled: false } });
