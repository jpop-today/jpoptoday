import { loadGuides } from '../../contracts/guides.mjs';
/** Published guide count comes from the markdown, so new guides don't need e2e edits. */
export const publishedGuideCount = loadGuides().filter(guide => !guide.draft).length;
