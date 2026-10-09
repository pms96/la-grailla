/* Registro de DESARROLLO compatible con la API REST de Upstash (SET / GET / DEL), en memoria.
 * Sirve para probar el panel y, más adelante, el front sin cuenta de Upstash.
 *
 *   npm run dev:registry          (escucha en 127.0.0.1:3113, token "dev")
 *   GET /dump                     (lista todo lo que hay guardado)
 */
import http from 'node:http';

const PORT = Number(process.env.DEV_REGISTRY_PORT ?? 3113);
const TOKEN = process.env.DEV_REGISTRY_TOKEN ?? 'dev';
/** Opcional: un segundo token que solo puede leer (GET/SCAN), como el «Read-Only Token» de Upstash. */
const READ_ONLY_TOKEN = process.env.DEV_REGISTRY_READ_ONLY_TOKEN;
const data = new Map<string, string>();

http
  .createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const auth = req.headers.authorization;
    const readOnly = !!READ_ONLY_TOKEN && auth === `Bearer ${READ_ONLY_TOKEN}`;
    if (auth !== `Bearer ${TOKEN}` && !readOnly) return json(401, { error: 'Unauthorized' });
    if (req.method === 'GET' && req.url === '/dump') return json(200, Object.fromEntries(data));
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let cmd: unknown;
      try {
        cmd = JSON.parse(body);
      } catch {
        return json(400, { error: 'ERR invalid JSON' });
      }
      if (!Array.isArray(cmd) || !cmd.every((c) => typeof c === 'string')) return json(400, { error: 'ERR invalid command' });
      const [op, key, value] = cmd as string[];
      if (readOnly && !['GET', 'SCAN'].includes(op?.toUpperCase())) return json(400, { error: `NOPERM this user has no permissions to run the '${op?.toLowerCase()}' command` });
      switch (op?.toUpperCase()) {
        case 'SCAN':
          return json(200, { result: ['0', [...data.keys()]] });
        case 'SET':
          data.set(key, value);
          return json(200, { result: 'OK' });
        case 'GET':
          return json(200, { result: data.get(key) ?? null });
        case 'DEL':
          return json(200, { result: data.delete(key) ? 1 : 0 });
        default:
          return json(400, { error: `ERR unknown command '${op}'` });
      }
    });
  })
  .listen(PORT, '127.0.0.1', () => console.log(`registro de desarrollo en http://127.0.0.1:${PORT}`));
