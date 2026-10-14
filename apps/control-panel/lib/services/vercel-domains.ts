import { ServiceError } from './errors';
import type { FetchLike } from './tenant-calls';

/* Añadir el dominio de un cliente al proyecto de Vercel de la plataforma desde el panel (API REST de Vercel), en lugar de hacerlo a mano en
 * su web. Solo hace falta en el proyecto `grailla-platform`: el front se sirve ahí por Host.
 *
 *   VERCEL_API_TOKEN              token de Vercel (Sensitive). Los tokens de Vercel son del EQUIPO, no de un proyecto: crea uno solo para esto
 *                                 y caduca/rótalo; con él se pueden tocar los proyectos del equipo.
 *   VERCEL_PLATFORM_PROJECT_ID    id (prj_…) o nombre del proyecto `grailla-platform`.
 *   VERCEL_TEAM_ID                id del equipo (team_…); omitir en una cuenta personal.
 *
 * Sin las dos primeras la función no existe (`vercelConfig()` devuelve null) y el panel solo enseña qué registro DNS crear. El token solo va en
 * la cabecera Authorization: ningún error ni resultado lo contiene. */

export type VercelConfig = { token: string; projectId: string; teamId?: string };

export function vercelConfig(env: NodeJS.ProcessEnv = process.env): VercelConfig | null {
  const token = env.VERCEL_API_TOKEN?.trim();
  const projectId = env.VERCEL_PLATFORM_PROJECT_ID?.trim();
  if (!token || !projectId) return null;
  return { token, projectId, teamId: env.VERCEL_TEAM_ID?.trim() || undefined };
}

export type DnsRecord = { type: 'A' | 'CNAME' | 'TXT'; name: string; value: string };
export type DomainSetup = {
  host: string;
  /** El dominio ya estaba en el proyecto antes de esta llamada. */
  inProject: boolean;
  /** Esta llamada lo ha añadido. */
  created: boolean;
  /** Vercel lo da por verificado como dominio del proyecto (puede pedir un TXT si estuvo en otra cuenta). */
  verified: boolean | null;
  /** El DNS actual no apunta a Vercel (null si no se pudo comprobar). */
  misconfigured: boolean | null;
  /** Qué crear en el DNS del cliente. */
  records: DnsRecord[];
};

const DEFAULT_CNAME = 'cname.vercel-dns.com';
const DEFAULT_A = '76.76.21.21';
const TIMEOUT_MS = 15_000;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

async function call(cfg: VercelConfig, method: 'GET' | 'POST', path: string, body: unknown, fetchImpl: FetchLike): Promise<{ status: number; json: Json }> {
  const url = `https://api.vercel.com${path}${cfg.teamId ? `${path.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(cfg.teamId)}` : ''}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${cfg.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: controller.signal,
    });
    const text = await res.text();
    let json: Json = {};
    try {
      json = obj(JSON.parse(text));
    } catch {
      // cuerpo no JSON: se trata como vacío
    }
    return { status: res.status, json };
  } catch {
    throw new ServiceError('vercel_unreachable', 'No se pudo hablar con la API de Vercel (red o tiempo agotado). Reintenta en un minuto.');
  } finally {
    clearTimeout(timer);
  }
}

function failure(status: number, json: Json): ServiceError {
  const err = obj(json.error);
  const code = str(err.code);
  const message = str(err.message)?.slice(0, 200);
  if (status === 401 || status === 403) return new ServiceError('vercel_forbidden', 'Vercel rechaza el token (caducado, sin permiso sobre ese proyecto o equipo equivocado): revisa VERCEL_API_TOKEN y VERCEL_TEAM_ID en el panel.');
  if (code === 'domain_already_in_use' || status === 409) return new ServiceError('domain_in_other_project', 'Ese dominio ya está en otro proyecto de Vercel: quítalo de allí primero.');
  return new ServiceError('vercel_error', `Vercel respondió ${status}${code ? ` (${code})` : ''}${message ? `: ${message}` : ''}`);
}

/** Registros DNS que el cliente tiene que crear, a partir de la respuesta de Vercel (con los valores clásicos si no trae recomendaciones). */
export function dnsRecordsFor(host: string, apex: string | undefined, verification: unknown, config: Json | null): DnsRecord[] {
  const records: DnsRecord[] = [];
  if (Array.isArray(verification)) {
    for (const v of verification) {
      const o = obj(v);
      const domain = str(o.domain);
      const value = str(o.value);
      if (str(o.type)?.toUpperCase() === 'TXT' && domain && value) records.push({ type: 'TXT', name: domain, value });
    }
  }
  if (config?.misconfigured === false) return records;
  const isApex = apex ? host === apex : host.split('.').length <= 2;
  if (isApex) {
    const ipv4 = Array.isArray(config?.recommendedIPv4) ? obj((config!.recommendedIPv4 as unknown[])[0]).value : undefined;
    const value = Array.isArray(ipv4) ? str(ipv4[0]) : undefined;
    records.push({ type: 'A', name: host, value: value ?? DEFAULT_A });
  } else {
    const cname = Array.isArray(config?.recommendedCNAME) ? str(obj((config!.recommendedCNAME as unknown[])[0]).value) : undefined;
    records.push({ type: 'CNAME', name: host, value: (cname ?? DEFAULT_CNAME).replace(/\.$/, '') });
  }
  return records;
}

/** Añade el dominio al proyecto (si no estaba), y dice si el DNS ya apunta a Vercel y qué registros faltan. Repetible. */
export async function ensureVercelDomain(host: string, cfg: VercelConfig, fetchImpl: FetchLike = fetch): Promise<DomainSetup> {
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) || !host.includes('.')) throw new ServiceError('invalid_host', 'El dominio no es válido para Vercel');
  const project = encodeURIComponent(cfg.projectId);

  let inProject = false;
  let created = false;
  let data: Json;
  const existing = await call(cfg, 'GET', `/v9/projects/${project}/domains/${encodeURIComponent(host)}`, undefined, fetchImpl);
  if (existing.status === 200) {
    inProject = true;
    data = existing.json;
  } else if (existing.status === 404) {
    const added = await call(cfg, 'POST', `/v10/projects/${project}/domains`, { name: host }, fetchImpl);
    if (added.status < 200 || added.status >= 300) throw failure(added.status, added.json);
    created = true;
    data = added.json;
  } else {
    throw failure(existing.status, existing.json);
  }

  // Si falla la comprobación del DNS no se pierde lo hecho: se devuelve sin saber si está bien apuntado.
  const conf = await call(cfg, 'GET', `/v6/domains/${encodeURIComponent(host)}/config`, undefined, fetchImpl).catch(() => null);
  const config = conf && conf.status === 200 ? conf.json : null;
  return {
    host,
    inProject,
    created,
    verified: typeof data.verified === 'boolean' ? data.verified : null,
    misconfigured: typeof config?.misconfigured === 'boolean' ? config.misconfigured : null,
    records: dnsRecordsFor(host, str(data.apexName), data.verification, config),
  };
}

/** El mismo resultado en texto para el operador. */
export function describeDomainSetup(s: DomainSetup): string[] {
  const lines: string[] = [];
  lines.push(s.created ? `✓ ${s.host} añadido al proyecto de Vercel` : `✓ ${s.host} ya estaba en el proyecto de Vercel`);
  if (s.misconfigured === false && s.records.length === 0) lines.push('✓ El DNS ya apunta a Vercel');
  for (const r of s.records) lines.push(`Crea este registro en el DNS del cliente: ${r.type} ${r.name} → ${r.value}`);
  if (s.verified === false) lines.push('Vercel todavía no da el dominio por verificado: crea el registro TXT de arriba y repite.');
  if (s.misconfigured === null) lines.push('No se pudo comprobar el DNS: repite en un minuto.');
  return lines;
}
