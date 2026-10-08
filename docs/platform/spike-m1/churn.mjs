// Uso: node churn.mjs <dir> <lib|adapter> <ciclos> — crea/usa/desconecta clientes en rotación (simula LRU con expulsiones)
import { createRequire } from 'node:module';
import path from 'node:path';
const [dir, mode, cyc] = process.argv.slice(2);
const require = createRequire(path.resolve(dir, 'x.js'));
const { PrismaClient } = require('@prisma/client');
const PW = process.env.PW;
const url = (i) => `postgresql://lagrailla:${PW}@localhost:5432/spike_t${i}${mode==='lib'?'?connection_limit=2':''}`;
const mb = () => +(process.memoryUsage().rss / 1048576).toFixed(1);
let PrismaPg; if (mode === 'adapter') ({ PrismaPg } = require('@prisma/adapter-pg'));
const mk = (i) => mode === 'adapter' ? new PrismaClient({ adapter: new PrismaPg({ connectionString: url(i), max: 2 }) }) : new PrismaClient({ datasources: { db: { url: url(i) } } });
const samples = [];
for (let c = 1; c <= Number(cyc); c++) {
  const i = (c % 16) + 1;
  const cl = mk(i);
  const rs = await Promise.all(Array.from({ length: 10 }, () => cl.appConfig.findFirst({ where: { key: 'site_name' } })));
  if (rs.some((r) => r?.value !== `Tenant ${i}`)) throw new Error('AISLAMIENTO ROTO');
  await cl.$disconnect();
  if (c % 50 === 0) { global.gc?.(); samples.push(mb()); }
}
console.log(`${dir} ${cyc} ciclos create+10 queries+disconnect → RSS cada 50 ciclos (MB): ${samples.join(' → ')}`);
