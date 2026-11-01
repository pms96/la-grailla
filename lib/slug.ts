import { Prisma } from '@prisma/client';

/* Slugs únicos de eventos y productos (H-052). Antes se derivaban SOLO del nombre: «Noche de Feria» al año siguiente, o un nombre sin letras ni números (que dejaba
 * el slug vacío), daban P2002, `handleApiError` no lo mapeaba (500 genérico) y el admin no podía crear el evento. */

const MAX_SLUG = 80;
const MAX_NUMBERED_ATTEMPTS = 20;

/** Slug del nombre: minúsculas, sin tildes ni símbolos, con guiones. Un nombre sin letras ni números usa `fallback` (nunca vacío). */
export function baseSlug(name: string | null | undefined, fallback: string): string {
  const slug = (name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-$/, '');
  return slug || fallback;
}

const isSlugCollision = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002' &&
  [error.meta?.target].flat().some((t) => typeof t === 'string' && t.includes('slug'));

/**
 * Crea la fila con un slug libre: prueba `base`, `base-2`, `base-3`… (saltando los que `exists` ya ve ocupados) y, si otra alta simultánea gana la carrera y la BD
 * responde P2002 sobre el slug, pasa al siguiente. Agotados los intentos numerados usa un sufijo aleatorio. Cualquier otro error se propaga.
 * `create` debe ser reejecutable (una transacción entera): un P2002 aborta la transacción en curso.
 */
export async function createWithUniqueSlug<T>(base: string, exists: (slug: string) => Promise<boolean>, create: (slug: string) => Promise<T>): Promise<T> {
  const candidate = (n: number) => (n === 1 ? base : `${base}-${n}`);
  for (let n = 1; n <= MAX_NUMBERED_ATTEMPTS; n += 1) {
    const slug = candidate(n);
    if (await exists(slug)) continue;
    try {
      return await create(slug);
    } catch (error) {
      if (!isSlugCollision(error)) throw error;
    }
  }
  return create(`${base}-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`);
}
