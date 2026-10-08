import { Suspense } from 'react';
import { siteName, currentTenantId } from '@/lib/tenant';
export const dynamic = 'force-dynamic';
export async function generateMetadata() { return { title: `META:${await siteName()}` }; }
async function Slow() { await new Promise((r) => setTimeout(r, 40)); return <p id="slow">SLOW:{currentTenantId()}:{await siteName()}</p>; }
export default async function Page() {
  return <main><h1 id="h1">H1:{await siteName()}</h1><Suspense fallback="…"><Slow /></Suspense></main>;
}
