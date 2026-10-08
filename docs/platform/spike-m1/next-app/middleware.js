import { NextResponse } from 'next/server';
import { verifySnapshot, deriveSecret } from './lib/crypto';
import * as ed from '@noble/ed25519';
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
const L1 = new Map(); // host -> {rec, exp}
export async function middleware(req) {
  const host = (req.headers.get('host') || '').split(':')[0].toLowerCase();
  let rec = null, fetchMs = 0, verifyMs = 0, l1 = 'miss';
  const hit = L1.get(host);
  if (hit && hit.exp > Date.now()) { rec = hit.rec; l1 = 'hit'; }
  else {
    const t0 = performance.now();
    const r = await fetch(`${process.env.REGISTRY_URL}/r/${host}`, { cache: 'no-store' });
    fetchMs = performance.now() - t0;
    if (!r.ok) return new NextResponse('Sitio no configurado', { status: 404 });
    const { payload, sig } = await r.json();
    const t1 = performance.now();
    const ok = await verifySnapshot(process.env.SNAPSHOT_PUBKEY, payload, sig);
    verifyMs = performance.now() - t1;
    if (!ok) return new NextResponse('Firma inválida', { status: 503 });
    rec = JSON.parse(payload);
    L1.set(host, { rec, exp: Date.now() + 15000 });
  }
  if (rec.revoked) return new NextResponse('Suspendido', { status: 503 });
  const headers = new Headers(req.headers);
  headers.delete('x-tenant-id');            // nunca confiar en lo que mande el cliente
  headers.set('x-tenant-id', rec.tenantId);
  const res = NextResponse.next({ request: { headers } });
  if (req.nextUrl.searchParams.get('probe')) {
    const { payload, sig } = await (await fetch(`${process.env.REGISTRY_URL}/r/${host}`, { cache: 'no-store' })).json();
    const hex2 = (h) => new Uint8Array(h.match(/../g).map((b) => parseInt(b, 16)));
    const t = performance.now();
    const nobleOk = await ed.verifyAsync(hex2(sig), new TextEncoder().encode(payload), hex2(process.env.SNAPSHOT_PUBKEY));
    res.headers.set('x-edge-probe', `hkdf=${await deriveSecret(process.env.PLATFORM_MASTER, rec.tenantId)};noble=${nobleOk}:${(performance.now() - t).toFixed(2)}ms;runtime=${typeof EdgeRuntime !== 'undefined' ? 'edge' : 'node'}`);
  }
  res.headers.set('x-edge-timing', `l1=${l1};fetch=${fetchMs.toFixed(1)};verify=${verifyMs.toFixed(2)}`);
  return res;
}
