import { describe, expect, it } from 'vitest';
import { UpstashReader } from '@/lib/tenant/resolve';
import { UpstashRegistryStore } from '../../apps/control-panel/lib/registry/store';

/* El panel escribe con UpstashRegistryStore y el front lee con UpstashReader: dos implementaciones del mismo protocolo REST, en dos apps.
 * Hasta ahora solo se habían probado a mano contra `dev:registry`. Aquí hablan entre sí a través de un Upstash falso con token. */

const URL = 'https://eu.example.upstash.io';

function fakeUpstash(token: string) {
  const data = new Map<string, string>();
  const calls: string[][] = [];
  const doFetch = async (_url: string, init?: RequestInit): Promise<Response> => {
    const headers = init?.headers as Record<string, string>;
    if (headers.Authorization !== `Bearer ${token}`) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    const cmd = JSON.parse(String(init?.body)) as string[];
    calls.push(cmd);
    const [op, key, value] = cmd;
    if (op === 'SET') {
      data.set(key, value);
      return new Response(JSON.stringify({ result: 'OK' }));
    }
    if (op === 'GET') return new Response(JSON.stringify({ result: data.get(key) ?? null }));
    if (op === 'DEL') return new Response(JSON.stringify({ result: data.delete(key) ? 1 : 0 }));
    return new Response(JSON.stringify({ error: `ERR unknown command ${op}` }), { status: 400 });
  };
  return { data, calls, doFetch };
}

describe('el panel escribe y el front lee el mismo registro', () => {
  it('lo que publica el panel lo lee el front, y lo que borra desaparece', async () => {
    const up = fakeUpstash('t');
    const writer = new UpstashRegistryStore(URL, 't', up.doFetch);
    const reader = new UpstashReader(URL, 't', up.doFetch);

    await writer.put('h:a.cliente.test', '{"firmado":true}');
    expect(await reader.get('h:a.cliente.test')).toBe('{"firmado":true}');
    expect(await reader.get('h:nadie.test')).toBeNull();

    await writer.del('h:a.cliente.test');
    expect(await reader.get('h:a.cliente.test')).toBeNull();
  });

  it('valores con comillas, saltos de línea y unicode viajan intactos', async () => {
    const up = fakeUpstash('t');
    const value = JSON.stringify({ nombre: 'Peña "La Grailla"\nsegunda línea', e: '🎟️' });
    await new UpstashRegistryStore(URL, 't', up.doFetch).put('k', value);
    expect(await new UpstashReader(URL, 't', up.doFetch).get('k')).toBe(value);
  });

  it('con un token equivocado ninguno de los dos finge que funciona', async () => {
    const up = fakeUpstash('bueno');
    await expect(new UpstashRegistryStore(URL, 'malo', up.doFetch).put('k', 'v')).rejects.toThrow(/401/);
    await expect(new UpstashReader(URL, 'malo', up.doFetch).get('k')).rejects.toThrow(/401/);
  });

  it('un error de Redis en la respuesta se propaga', async () => {
    const doFetch = async () => new Response(JSON.stringify({ error: 'ERR max requests limit exceeded' }), { status: 200 });
    await expect(new UpstashRegistryStore(URL, 't', doFetch).put('k', 'v')).rejects.toThrow(/max requests/);
    await expect(new UpstashReader(URL, 't', doFetch).get('k')).rejects.toThrow(/max requests/);
  });

  it('una escritura que Redis no confirma con OK no cuenta como publicada', async () => {
    const doFetch = async () => new Response(JSON.stringify({ result: null }));
    await expect(new UpstashRegistryStore(URL, 't', doFetch).put('k', 'v')).rejects.toThrow(/no confirmó/);
  });

  it('un registro que no responde (timeout) hace fallar la lectura y la escritura', async () => {
    const doFetch = async (): Promise<Response> => {
      throw new DOMException('The operation timed out', 'TimeoutError');
    };
    await expect(new UpstashRegistryStore(URL, 't', doFetch).put('k', 'v')).rejects.toThrow();
    await expect(new UpstashReader(URL, 't', doFetch).get('k')).rejects.toThrow();
  });
});
