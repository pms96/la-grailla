import http from 'node:http';
const TOTAL = Number(process.argv[2] || 600), CONC = Number(process.argv[3] || 40);
const get = (host, path) => new Promise((res, rej) => {
  const t = performance.now();
  http.get({ host: '127.0.0.1', port: 3111, path, headers: { host }, agent: new http.Agent({ keepAlive: true }) }, (r) => {
    let b = ''; r.on('data', (d) => (b += d)).on('end', () => res({ code: r.statusCode, body: b, ms: performance.now() - t }));
  }).on('error', rej);
});
let bad = 0, n = 0, lat = [];
async function worker() {
  while (n < TOTAL) {
    const k = n++; const i = (k * 7) % 16 + 1; const host = `t${i}.test`;
    const kind = k % 3;
    const r = await get(host, kind === 0 ? '/api/whoami' : kind === 1 ? '/' : '/api/whoami');
    lat.push(r.ms);
    const want = `Tenant ${i}`;
    let ok = r.code === 200;
    if (kind === 1) ok = ok && r.body.includes(`H1:<!-- -->${want}`) && r.body.includes(`META:${want}`) && r.body.includes(`T${i}<!-- -->:<!-- -->${want}`);
    else { let j = {tx:{}}; try { j = JSON.parse(r.body); } catch { ok = false; } ok = ok && j.viaAls === `T${i}` && j.viaHeaders === `T${i}` && j.direct === want && j.tx.row === want && j.tx.stillAls === `T${i}` && j.after === `T${i}`; }
    if (!ok) { bad++; if (bad < 4) console.log('MEZCLA/FALLO', host, r.code, r.body.slice(0, 200)); }
  }
}
const t0 = performance.now();
await Promise.all(Array.from({ length: CONC }, worker));
lat.sort((a, b) => a - b);
console.log(`peticiones=${TOTAL} concurrencia=${CONC} errores/mezclas=${bad} total=${((performance.now() - t0) / 1000).toFixed(1)}s p50=${lat[Math.floor(lat.length * .5)].toFixed(0)}ms p95=${lat[Math.floor(lat.length * .95)].toFixed(0)}ms`);
