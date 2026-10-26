import type { ModuleKey } from '@grailla/contracts';

/* Descripción de respaldo para la portada cuando el cliente no ha escrito ni descripción ni eslogan. Sin ella, el buscador se inventa un
 * fragmento cualquiera (a veces el aviso de cookies). Solo dice lo que el sitio realmente ofrece según sus módulos: nunca un texto de marca. */

const OFFER: readonly { module: ModuleKey; text: string }[] = [
  { module: 'entradas', text: 'eventos y entradas online' },
  { module: 'tienda', text: 'tienda online' },
  { module: 'sponsors', text: 'patrocinio para marcas' },
];

function join(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

/** `undefined` si no hay nada cierto que decir (mejor sin descripción que con una vacía). */
export function fallbackDescription(name: string, modules: readonly ModuleKey[]): string | undefined {
  const brand = name.trim();
  const offered = OFFER.filter((o) => modules.includes(o.module)).map((o) => o.text);
  if (!brand || offered.length === 0) return undefined;
  return `${brand}: ${join(offered)}.`;
}
