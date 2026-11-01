import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import { getAndSetConfig, restoreConfig, restoreConfigSnapshot, snapshotConfig } from '../helpers/fixtures';
import { journalForget, journalNote, journalOriginal, journalPath, recoverConfigJournal, type ConfigRow } from '../helpers/config-journal';

/* H-151: los tests que pisan o borran configuración real de la BD de desarrollo apuntan antes el original en un diario; si la ejecución muere a medias (Ctrl-C, kill), la
 * siguiente suite lo recupera. Se prueba con claves sintéticas `zz_journal_*`, incluida la simulación del aborto. */

const A = 'zz_journal_a';
const B = 'zz_journal_b';
const KEYS = [A, B];
const row = (key: string, value: string, label: string | null = key, group: string | null = 'zz'): ConfigRow => ({ key, value, label, group });

async function wipe() {
  await prisma.appConfig.deleteMany({ where: { key: { in: KEYS } } });
  for (const k of KEYS) journalForget(k);
}

describe('config-journal (H-151)', () => {
  beforeEach(wipe);
  afterEach(wipe);
  afterAll(wipe);

  it('el diario es por BD: la ruta cambia con DATABASE_URL y vive en el directorio temporal, fuera del repo', () => {
    const a = journalPath('postgresql://x@localhost/uno');
    const b = journalPath('postgresql://x@localhost/dos');
    expect(a).not.toBe(b);
    expect(path.dirname(a)).toBe(os.tmpdir());
  });

  it('apunta el original solo la PRIMERA vez (un segundo apunte no pisa el valor real) y se puede tachar', () => {
    journalNote(A, row(A, 'real'));
    journalNote(A, row(A, 'ya-pisado'));
    expect(journalOriginal(A)).toEqual(row(A, 'real'));
    journalForget(A);
    expect(journalOriginal(A)).toBeUndefined();
  });

  it('el archivo del diario se crea con permisos 0600 (puede contener secretos reales de desarrollo) y desaparece al quedar vacío', () => {
    journalNote(A, row(A, 'secreto'));
    const mode = fs.statSync(journalPath()).mode & 0o777;
    expect(mode).toBe(0o600);
    journalForget(A);
    expect(fs.existsSync(journalPath())).toBe(false);
  });

  it('getAndSetConfig + restoreConfig (clave que NO existía): queda sin fila y sin entrada en el diario', async () => {
    const original = await getAndSetConfig(A, 'valor-de-test');
    expect(original).toBeNull();
    expect(journalOriginal(A)).toBeNull(); // «no existía»
    await restoreConfig(A, original);
    expect(await prisma.appConfig.findUnique({ where: { key: A } })).toBeNull();
    expect(journalOriginal(A)).toBeUndefined();
  });

  it('getAndSetConfig + restoreConfig (clave que SÍ existía): vuelve el valor y sale del diario', async () => {
    await prisma.appConfig.create({ data: row(A, 'real') });
    const original = await getAndSetConfig(A, 'pisado');
    expect((await prisma.appConfig.findUniqueOrThrow({ where: { key: A } })).value).toBe('pisado');
    await restoreConfig(A, original);
    expect((await prisma.appConfig.findUniqueOrThrow({ where: { key: A } })).value).toBe('real');
    expect(journalOriginal(A)).toBeUndefined();
  });

  it('restoreConfig vuelve a CREAR una clave que el test borró por el camino (antes lo tragaba en silencio)', async () => {
    await prisma.appConfig.create({ data: row(A, 'real') });
    const original = await getAndSetConfig(A, 'pisado');
    await prisma.appConfig.deleteMany({ where: { key: A } }); // el test borra la fila
    await restoreConfig(A, original);
    expect((await prisma.appConfig.findUniqueOrThrow({ where: { key: A } })).value).toBe('real');
  });

  it('anidado: la restauración intermedia NO tacha la entrada del test exterior', async () => {
    await prisma.appConfig.create({ data: row(A, 'real') });
    const outer = await getAndSetConfig(A, 'fuera'); // original: real
    const inner = await getAndSetConfig(A, 'dentro'); // original visto: fuera
    await restoreConfig(A, inner);
    expect(journalOriginal(A)).toEqual(row(A, 'real')); // sigue apuntado el valor REAL
    await restoreConfig(A, outer);
    expect(journalOriginal(A)).toBeUndefined();
    expect((await prisma.appConfig.findUniqueOrThrow({ where: { key: A } })).value).toBe('real');
  });

  it('snapshotConfig deja las claves borradas y restoreConfigSnapshot recrea lo real, con su etiqueta y grupo', async () => {
    await prisma.appConfig.create({ data: row(A, 'real-a', 'Etiqueta A', 'grupo-a') });
    const saved = await snapshotConfig(KEYS);
    expect(await prisma.appConfig.count({ where: { key: { in: KEYS } } })).toBe(0);
    await prisma.appConfig.create({ data: row(B, 'lo-que-deja-el-test') });
    await restoreConfigSnapshot(KEYS, saved);
    expect(await prisma.appConfig.findUniqueOrThrow({ where: { key: A }, select: { key: true, value: true, label: true, group: true } })).toEqual(row(A, 'real-a', 'Etiqueta A', 'grupo-a'));
    expect(await prisma.appConfig.findUnique({ where: { key: B } })).toBeNull(); // lo que no existía antes, no queda
    expect(journalOriginal(A)).toBeUndefined();
    expect(journalOriginal(B)).toBeUndefined();
  });

  it('ABORTO: tras morir a medias (sin restaurar), recoverConfigJournal devuelve lo real y borra lo que no existía', async () => {
    await prisma.appConfig.create({ data: row(A, 'real-a', 'Etiqueta A', 'grupo-a') });
    await snapshotConfig(KEYS); // el test borra las claves…
    await prisma.appConfig.create({ data: row(B, 'basura-del-test') }); // …escribe lo suyo…
    await prisma.appConfig.create({ data: row(A, 'pisado-por-el-test') });
    // …y la ejecución muere aquí: no hay `afterAll`. El diario sigue en disco:
    expect(fs.existsSync(journalPath())).toBe(true);

    const recovered = await recoverConfigJournal(prisma);
    expect(recovered.sort()).toEqual([...KEYS].sort());
    expect(await prisma.appConfig.findUniqueOrThrow({ where: { key: A }, select: { key: true, value: true, label: true, group: true } })).toEqual(row(A, 'real-a', 'Etiqueta A', 'grupo-a'));
    expect(await prisma.appConfig.findUnique({ where: { key: B } })).toBeNull();
    expect(fs.existsSync(journalPath())).toBe(false); // y el diario queda vacío
    expect(await recoverConfigJournal(prisma)).toEqual([]); // idempotente
  });
});
