#!/usr/bin/env node
/**
 * Render scripts/og-template.html to public/og/default.png (1200x630).
 * Run by hand after editing the template; the PNG is committed so builds never need a browser.
 */
import { chromium } from 'playwright';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.goto(pathToFileURL(join(root, 'scripts/og-template.html')).href);
  await page.screenshot({ path: join(root, 'public/og/default.png') });
  console.log('Rendered public/og/default.png');
} finally {
  await browser.close();
}
