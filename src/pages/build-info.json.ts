import { buildInfo } from '../lib/catalog';
export function GET() { return new Response(JSON.stringify(buildInfo), { headers: { 'Content-Type': 'application/json; charset=utf-8' } }); }
