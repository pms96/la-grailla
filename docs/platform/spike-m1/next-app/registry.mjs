// Registro simulado (hace de Upstash REST): devuelve snapshots firmados con Ed25519
import http from 'node:http'; import crypto from 'node:crypto'; import fs from 'node:fs';
const priv = crypto.createPrivateKey(JSON.parse(fs.readFileSync('keys.json')).priv);
const LAT = Number(process.env.REG_LATENCY_MS || 0);
const revoked = new Set(); let seq = 1; let hits = 0;
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/stats') { res.end(JSON.stringify({ hits })); return; }
  if (u.pathname.startsWith('/revoke/')) { revoked.add(u.pathname.slice(8)); res.end('ok'); return; }
  if (u.pathname.startsWith('/r/')) {
    hits++;
    const host = u.pathname.slice(3);
    const m = /^t(\d+)\.test$/.exec(host);
    if (LAT) await new Promise((r) => setTimeout(r, LAT));
    if (!m) { res.statusCode = 404; res.end('{}'); return; }
    const payload = JSON.stringify({ tenantId: 'T' + m[1], db: Number(m[1]), host, seq: seq++, iat: Date.now(), staleUntil: Date.now() + 86400e3, contractVersion: 1, revoked: revoked.has('T' + m[1]) });
    const sig = crypto.sign(null, Buffer.from(payload), priv).toString('hex');
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ payload, sig })); return;
  }
  res.statusCode = 404; res.end();
}).listen(3112, () => console.log('registry :3112 latency', LAT));
