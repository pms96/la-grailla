import 'dotenv/config';
import { generateMasterKey, generateSigningKeyPair } from '@grailla/contracts';

// Los tests NUNCA tocan la BD de control real: se fuerza la de pruebas y se
// aborta si el nombre no termina en `_test`.
const real = process.env.CONTROL_DATABASE_URL ?? '';
if (!real) throw new Error('CONTROL_DATABASE_URL no está definido (copia .env.example a .env)');
const url = new URL(real);
if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Los tests del panel solo corren contra un Postgres local');
if (!url.pathname.endsWith('_test')) url.pathname = `${url.pathname}_test`;
if (!url.pathname.replace('/', '').endsWith('_test')) throw new Error('La BD de test debe terminar en _test');
process.env.CONTROL_DATABASE_URL = url.toString();
process.env.CONTROL_DIRECT_URL = url.toString();

// Claves efímeras: los tests no dependen de las del .env.
process.env.SECRETS_ACTIVE_KID = 'mtest';
process.env.SECRETS_KEYS = JSON.stringify({ mtest: generateMasterKey() });
const { privateKey } = await generateSigningKeyPair();
process.env.SNAPSHOT_KID = 'stest';
process.env.SNAPSHOT_SIGNING_KEY = privateKey;
process.env.REGISTRY_STORE = 'memory';
process.env.BCRYPT_COST = '4'; // los hashes de prueba no necesitan ser caros
