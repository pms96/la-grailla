import crypto from 'node:crypto';
import { ServiceError } from './errors';

/* Identidad de una base de datos (servidor + puerto + nombre), para saber si dos URLs apuntan a LA MISMA.
 *
 * Cada cliente tiene su BD y nada más: si dos clientes compartieran una (un copia-pega equivocado al dar de alta, o una URL cambiada a la
 * de otro cliente) verían los datos del otro. La identidad se guarda como huella (`Subscription.dbFingerprint`, única) para poder impedirlo
 * sin descifrar las URLs. No es un secreto: no lleva usuario ni contraseña. */

export type DatabaseIdentity = { host: string; port: string; db: string };

export function databaseIdentity(rawUrl: string): DatabaseIdentity {
  const u = new URL(rawUrl);
  const labels = u.hostname.toLowerCase().split('.');
  // Neon: la URL con pooler lleva «-pooler» en el primer tramo del host; es el mismo servidor que la directa.
  labels[0] = labels[0].replace(/-pooler$/, '');
  return { host: labels.join('.'), port: u.port || '5432', db: decodeURIComponent(u.pathname.replace(/^\//, '')) };
}

/** Huella estable de la BD a la que apunta la URL (de la directa: la que migra y siembra). */
export function databaseFingerprint(rawUrl: string): string {
  const id = databaseIdentity(rawUrl);
  return crypto.createHash('sha256').update(`${id.host}:${id.port}/${id.db}`).digest('hex');
}

/**
 * La URL con pooler y la directa deben ser de la misma BD. En Neon se comprueba el servidor (todas las BDs se llaman `neondb`, así que el
 * nombre solo no distingue); con el mismo host, el nombre de la BD debe coincidir. Con otros proveedores (que usan otro host para el
 * pooler) solo se comprueba lo que se puede saber.
 */
export function assertSameDatabase(pooledUrl: string, directUrl: string): void {
  const p = databaseIdentity(pooledUrl);
  const d = databaseIdentity(directUrl);
  const neon = (h: string) => h.endsWith('.neon.tech');
  if ((neon(p.host) && neon(d.host) && p.host !== d.host) || (p.host === d.host && p.db !== d.db)) {
    throw new ServiceError('database_mismatch', 'La URL con pooler y la directa apuntan a bases de datos distintas: revisa que sean las del mismo cliente');
  }
}
