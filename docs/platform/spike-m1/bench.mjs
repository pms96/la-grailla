// Uso: node bench.mjs <dir> <mode:lib|adapter> <N> [--json]
import { createRequire } from 'node:module';
import path from 'node:path';
const [dir, mode, nStr] = process.argv.slice(2);
const N = Number(nStr);
const require = createRequire(path.resolve(dir, 'x.js'));
const { PrismaClient } = require('@prisma/client');
const PW = process.env.PW;
const url = (i) => `postgresql://lagrailla:${PW}@localhost:5432/spike_t${i}`;
const mb = (b) => +(b / 1048576).toFixed(1);
const rss = () => mb(process.memoryUsage().rss);
const rows = [];
const base = rss();
let PrismaPg;
if (mode === 'adapter') ({ PrismaPg } = require('@prisma/adapter-pg'));
const clients = [];
for (let i = 1; i <= N; i++) {
  const t0 = performance.now();
  const c = mode === 'adapter'
    ? new PrismaClient({ adapter: new PrismaPg({ connectionString: url(i), max: 2, idleTimeoutMillis: 10000 }) })
    : new PrismaClient({ datasources: { db: { url: url(i) } } });
  const tCtor = performance.now() - t0;
  const t1 = performance.now();
  const r = await c.appConfig.findFirst({ where: { key: 'site_name' } });
  const tFirst = performance.now() - t1;
  const t2 = performance.now();
  await c.appConfig.findFirst({ where: { key: 'site_name' } });
  const tWarm = performance.now() - t2;
  if (r?.value !== `Tenant ${i}`) throw new Error(`AISLAMIENTO ROTO: esperaba Tenant ${i}, got ${r?.value}`);
  clients.push(c);
  rows.push({ i, ctor: +tCtor.toFixed(1), first: +tFirst.toFixed(1), warm: +tWarm.toFixed(1), rss: rss() });
}
const peak = rss();
const t3 = performance.now();
await Promise.all(clients.map((c) => c.$disconnect()));
const tDisc = performance.now() - t3;
global.gc?.();
await new Promise((r) => setTimeout(r, 300));
const after = rss();
console.log(JSON.stringify({ dir, mode, N, baseRss: base, peakRss: peak, perClientMB: +((peak - base) / N).toFixed(1), afterDisconnectRss: after, disconnectMs: +tDisc.toFixed(0), rows }));
