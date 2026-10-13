import { publicCatalogBytes } from '../lib/catalog';
export function GET() { return new Response(publicCatalogBytes, { headers: { 'Content-Type': 'application/json; charset=utf-8' } }); }
