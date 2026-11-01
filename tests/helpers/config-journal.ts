import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* Diario de configuración de los tests (H-151). Varios tests pisan o borran claves REALES de `AppConfig` de la BD de desarrollo (claves de pasarela, pasarela de la
 * tienda, tipos de sponsors, textos del pie…) y las restauraban solo en `afterAll`: un Ctrl-C, un kill o un cuelgue del ordenador dejaban esas claves perdidas.
 *
 * Ahora lo primero que se hace con una clave es APUNTAR su valor original en un archivo del directorio temporal (fuera del repo, permisos 0600: puede contener secretos
 * reales de desarrollo). Cuando el test restaura, se tacha. Si la ejecución muere a medias, la entrada sigue ahí y `recoverConfigJournal` (que corre al ARRANCAR la
 * siguiente suite y al terminar esta, vía `globalSetup`) la devuelve a su sitio. El archivo es por BD (hash de DATABASE_URL): dos bases distintas no se pisan. */

export type ConfigRow = { key: string; value: string; label: string | null; group: string | null };
type Journal = Record<string, ConfigRow | null>;

export function journalPath(databaseUrl = process.env.DATABASE_URL ?? ''): string {
  const hash = crypto.createHash('sha1').update(databaseUrl).digest('hex').slice(0, 10);
  return path.join(os.tmpdir(), `lagrailla-test-config-journal-${hash}.json`);
}

function read(file: string): Journal {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Journal;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function write(file: string, journal: Journal): void {
  if (Object.keys(journal).length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.writeFileSync(file, JSON.stringify(journal), { mode: 0o600 });
}

/** Apunta cómo estaba la clave (`null` = no existía) la PRIMERA vez que un test la toca; las siguientes veces no pisan el original. */
export function journalNote(key: string, original: ConfigRow | null, file = journalPath()): void {
  const journal = read(file);
  if (key in journal) return;
  journal[key] = original;
  write(file, journal);
}

/** Tacha la clave: el test la ha restaurado. */
export function journalForget(key: string, file = journalPath()): void {
  const journal = read(file);
  if (!(key in journal)) return;
  delete journal[key];
  write(file, journal);
}

/** El original apuntado de una clave (`undefined` = no hay entrada). */
export function journalOriginal(key: string, file = journalPath()): ConfigRow | null | undefined {
  const journal = read(file);
  return key in journal ? journal[key] : undefined;
}

type ConfigClient = {
  appConfig: {
    deleteMany(args: { where: { key: string } }): Promise<unknown>;
    upsert(args: { where: { key: string }; update: Omit<ConfigRow, 'key'>; create: ConfigRow }): Promise<unknown>;
  };
};

/** Devuelve a su sitio lo que una ejecución anterior dejó apuntado (abortada, o con un test que olvidó restaurar). Devuelve las claves recuperadas. */
export async function recoverConfigJournal(client: ConfigClient, file = journalPath()): Promise<string[]> {
  const journal = read(file);
  const keys = Object.keys(journal);
  for (const key of keys) {
    const original = journal[key];
    if (original === null) await client.appConfig.deleteMany({ where: { key } });
    else await client.appConfig.upsert({ where: { key }, update: { value: original.value, label: original.label, group: original.group }, create: original });
  }
  write(file, {});
  return keys;
}
