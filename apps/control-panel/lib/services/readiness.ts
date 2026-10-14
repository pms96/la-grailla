import { isSchemaAtLeast, migrationStamp } from '@grailla/contracts';
// Misma constante que usa el middleware del front para decidir «Cliente en mantenimiento»: archivo puro, sin dependencias de Node.
import { FRONT_MIN_SCHEMA } from '../../../../lib/platform/min-schema';

/* «Puesta en marcha» de un cliente: qué le falta para estar funcionando, en el orden en que se hace. Es una función PURA sobre lo que el
 * panel ya sabe (registro, dominios, última salud): no abre la BD del cliente ni llama a su web, así la ficha carga siempre y rápido.
 * Lo que solo se sabe mirando la BD (datos mínimos) se comprueba al pulsar «Salir a producción». */

export type StepState = 'done' | 'todo' | 'attention';
export type StepKey = 'schema' | 'data' | 'domain' | 'publish' | 'health';
export type ReadinessStep = { key: StepKey; label: string; state: StepState; detail: string };

export type ReadinessInput = {
  /** Versión del esquema que declara el registro (la que decide el mantenimiento en el front). */
  schemaVersion: string | null;
  /** Última migración que trae este código (null si no se pudo leer la carpeta `prisma/` del front). */
  latestMigration: string | null;
  minSchema?: string;
  domains: { host: string; status: string; isPrimary: boolean }[];
  published: boolean;
  pendingChanges: boolean;
  publishError: string | null;
  health: { ok: boolean; status: string; error: string | null; onboardingComplete: boolean | null; onboardingMissing: string[] } | null;
};

export type Readiness = {
  steps: ReadinessStep[];
  /** Primer paso sin terminar, o null si todo está hecho. */
  next: StepKey | null;
  complete: boolean;
};

export function computeReadiness(input: ReadinessInput): Readiness {
  const min = input.minSchema ?? FRONT_MIN_SCHEMA;
  const steps: ReadinessStep[] = [];

  // 1. Esquema de la BD.
  const stamp = migrationStamp(input.schemaVersion);
  const latest = migrationStamp(input.latestMigration);
  if (input.schemaVersion === null) {
    steps.push({ key: 'schema', label: 'Base de datos migrada', state: 'todo', detail: 'Sin informar: pulsa «Migrar BD» (aplica lo pendiente y anota la versión en el registro).' });
  } else if (!isSchemaAtLeast(input.schemaVersion, min)) {
    steps.push({ key: 'schema', label: 'Base de datos migrada', state: 'attention', detail: `La web del cliente muestra «en mantenimiento»: el registro declara ${input.schemaVersion} y el front exige al menos ${min}. Pulsa «Migrar BD».` });
  } else if (stamp !== null && latest !== null && stamp < latest) {
    steps.push({ key: 'schema', label: 'Base de datos migrada', state: 'todo', detail: `Hay migraciones nuevas por aplicar (la última es ${input.latestMigration}). Sirve igualmente; pulsa «Migrar BD» cuando convenga.` });
  } else {
    steps.push({ key: 'schema', label: 'Base de datos migrada', state: 'done', detail: `Al día en ${input.schemaVersion}.` });
  }

  // 2. Datos mínimos (los lee la salud del front; antes de salir a producción se comprueban directamente en la BD).
  const h = input.health;
  if (h && h.onboardingComplete === false) {
    steps.push({ key: 'data', label: 'Datos mínimos del cliente', state: 'attention', detail: `Faltan: ${h.onboardingMissing.join(', ')}. Los completa el cliente desde su administración.` });
  } else if (h && h.onboardingComplete === true) {
    steps.push({ key: 'data', label: 'Datos mínimos del cliente', state: 'done', detail: 'Email de administración y textos legales completos.' });
  } else {
    steps.push({ key: 'data', label: 'Datos mínimos del cliente', state: 'todo', detail: 'Sin comprobar: se mira en su BD al pulsar «Salir a producción».' });
  }

  // 3. Dominio.
  const live = input.domains.filter((d) => d.status !== 'RELEASED');
  const verified = live.filter((d) => d.status === 'VERIFIED');
  if (live.length === 0) {
    steps.push({ key: 'domain', label: 'Dominio verificado', state: 'attention', detail: 'El cliente no tiene ningún dominio: añade uno más abajo.' });
  } else if (verified.length > 0) {
    steps.push({ key: 'domain', label: 'Dominio verificado', state: 'done', detail: `${(verified.find((d) => d.isPrimary) ?? verified[0]).host} verificado.` });
  } else {
    steps.push({ key: 'domain', label: 'Dominio verificado', state: 'todo', detail: `${live[0].host} pendiente de verificar: crea el registro TXT que se indica más abajo y pulsa «Salir a producción».` });
  }

  // 4. Publicación.
  if (input.publishError) {
    steps.push({ key: 'publish', label: 'Publicado', state: 'attention', detail: `El último intento falló: ${input.publishError}` });
  } else if (!input.published) {
    steps.push({ key: 'publish', label: 'Publicado', state: 'todo', detail: 'Todavía no está publicado: la web del cliente no existe para el público.' });
  } else if (input.pendingChanges) {
    steps.push({ key: 'publish', label: 'Publicado', state: 'todo', detail: 'Hay cambios sin publicar.' });
  } else {
    steps.push({ key: 'publish', label: 'Publicado', state: 'done', detail: 'Lo publicado coincide con el registro.' });
  }

  // 5. Salud de la web.
  if (!h) {
    steps.push({ key: 'health', label: 'La web responde', state: 'todo', detail: 'Sin comprobar: pulsa «Comprobar salud» cuando el dominio apunte a la plataforma.' });
  } else if (h.ok) {
    steps.push({ key: 'health', label: 'La web responde', state: 'done', detail: 'Última comprobación correcta.' });
  } else {
    steps.push({ key: 'health', label: 'La web responde', state: 'attention', detail: h.error ?? `Estado: ${h.status}` });
  }

  const next = steps.find((s) => s.state !== 'done')?.key ?? null;
  return { steps, next, complete: next === null };
}
