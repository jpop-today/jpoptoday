export interface FavoritesResolver {
  resolve(id: unknown): { status: string; canonicalId?: string | null };
}
export interface FavoritesBackup {
  values: unknown[];
  total: number;
  known: number;
  unresolved: number;
}
export const MAX_FAVORITES_BACKUP_BYTES: number;
export function formatFavoritesBackup(values: readonly unknown[], resolver: FavoritesResolver): string;
export function parseFavoritesBackup(text: string, resolver: FavoritesResolver): FavoritesBackup;
