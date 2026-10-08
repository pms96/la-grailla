const enc = new TextEncoder();
const hex2buf = (h) => new Uint8Array(h.match(/../g).map((b) => parseInt(b, 16)));
const buf2hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
export async function verifySnapshot(pubHex, payload, sigHex) {
  const key = await crypto.subtle.importKey('raw', hex2buf(pubHex), { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, hex2buf(sigHex), enc.encode(payload));
}
export async function deriveSecret(master, tenantId, info = 'nextauth-session-v1') {
  const k = await crypto.subtle.importKey('raw', enc.encode(master), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(tenantId), info: enc.encode(info) }, k, 256);
  return buf2hex(bits);
}
