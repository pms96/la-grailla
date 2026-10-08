import crypto from 'node:crypto'; import fs from 'node:fs';
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
fs.writeFileSync('keys.json', JSON.stringify({ priv: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
fs.writeFileSync('.env.local', `SNAPSHOT_PUBKEY=${raw}\nPLATFORM_MASTER=${crypto.randomBytes(32).toString('hex')}\nREGISTRY_URL=http://127.0.0.1:3112\n`);
console.log('ok', raw.slice(0, 16));
