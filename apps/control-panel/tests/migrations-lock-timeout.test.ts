import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { redactUrls, withConnectionLockTimeout } from '@/lib/migrations/executor';
import { runMigrationsForSubscription } from '@/lib/services/migrations';
import { createTenant } from '@/lib/services/tenants';
import { freshStore, makeOperator, resetControlDb, tenantInput } from './helpers';
import { createScratchDb, dropScratchDb, makeFixturePrismaDir, queryScratch } from './scratch-db';

/* El lock_timeout de una migración iba en `ALTER DATABASE … SET`, que afecta a TODAS las conexiones nuevas de la BD del cliente mientras dura:
 * las de ventas y taquilla esperan bloqueos de asesoramiento hasta 20 s y habrían fallado a los 3 s. Ahora va solo en la conexión del runner. */

describe('withConnectionLockTimeout', () => {
  it('añade el parámetro de arranque codificado con %20 y %3D (un «+» no se leería como espacio)', () => {
    const out = withConnectionLockTimeout('postgresql://u:p@ep-abc.eu-central-1.aws.neon.tech/neondb?sslmode=require', 3000);
    expect(out).toBe('postgresql://u:p@ep-abc.eu-central-1.aws.neon.tech/neondb?sslmode=require&options=-c%20lock_timeout%3D3000');
    expect(out).not.toContain('+');
  });

  it('sin parámetros previos usa «?»', () => {
    expect(withConnectionLockTimeout('postgresql://u:p@localhost:5432/db', 1500)).toBe('postgresql://u:p@localhost:5432/db?options=-c%20lock_timeout%3D1500');
  });

  it('conserva unas options que ya traiga la URL en lugar de pisarlas', () => {
    const out = withConnectionLockTimeout('postgresql://u:p@h/db?options=-c%20statement_timeout%3D5000', 3000);
    expect(new URL(out).searchParams.get('options')).toBe('-c statement_timeout=5000 -c lock_timeout=3000');
    expect(out.match(/options=/g)).toHaveLength(1);
  });

  it('no deja la contraseña ni el usuario alterados', () => {
    const out = withConnectionLockTimeout('postgresql://us%40er:p%2Fw@h/db', 3000);
    expect(out.startsWith('postgresql://us%40er:p%2Fw@h/db')).toBe(true);
  });
});

const DB = 'lagrailla_scratch_lockto_a';
let url = '';

beforeAll(async () => {
  url = await createScratchDb(DB);
});
afterAll(async () => {
  await dropScratchDb(DB);
});
beforeEach(async () => {
  await resetControlDb();
  freshStore();
  url = await createScratchDb(DB);
});

// Falla la migración (y por tanto el runner) si la sesión no tiene el lock_timeout pedido o si la BD tiene uno propio.
const SESSION_ONLY = `DO $$ BEGIN
  IF current_setting('lock_timeout') <> '1500ms' THEN RAISE EXCEPTION 'lock_timeout de la sesion: %', current_setting('lock_timeout'); END IF;
  IF EXISTS (SELECT 1 FROM pg_db_role_setting WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()) AND setconfig::text LIKE '%lock_timeout%') THEN
    RAISE EXCEPTION 'la BD tiene un lock_timeout propio';
  END IF;
END $$;`;

// Lo contrario: en el plan B la BD entera lo tiene mientras corre la migración.
const DATABASE_WIDE = `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_db_role_setting WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()) AND setconfig::text LIKE '%lock_timeout%') THEN
    RAISE EXCEPTION 'la BD no tiene lock_timeout';
  END IF;
END $$;`;

async function tenantOnScratch() {
  const { actor } = await makeOperator('SUPERADMIN');
  const { subscription } = await createTenant(tenantInput({ dbUrlPooled: url, dbUrlDirect: url }) as never, actor);
  return { actor, subscription };
}

describe('el runner pone el lock_timeout en su conexión, no en la BD del cliente', () => {
  it('por defecto: la migración ve el lock_timeout pedido y la BD no tiene ninguno propio', async () => {
    const { actor, subscription } = await tenantOnScratch();
    const dir = makeFixturePrismaDir({ '20270201000000_comprueba_sesion': SESSION_ONLY });
    const res = await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir, republish: false, lockTimeoutMs: 1500 });
    expect(res.error).toBeNull();
    expect(res.status).toBe('SUCCEEDED');
    expect(await queryScratch(DB, `SELECT 1 FROM pg_db_role_setting WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())`)).toHaveLength(0);
  });

  it('una conexión normal a la BD NO hereda el lock_timeout del runner', async () => {
    const { actor, subscription } = await tenantOnScratch();
    const dir = makeFixturePrismaDir({ '20270201000000_comprueba_sesion': SESSION_ONLY });
    await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir, republish: false, lockTimeoutMs: 1500 });
    const [row] = await queryScratch<{ lock_timeout: string }>(DB, `SHOW lock_timeout`);
    expect(row.lock_timeout).toBe('0');
  });

  it('plan B (MIGRATION_LOCK_TIMEOUT_MODE / lockTimeoutMode=database): la BD entera lo tiene mientras corre, y se retira después', async () => {
    const { actor, subscription } = await tenantOnScratch();
    const dir = makeFixturePrismaDir({ '20270201000000_comprueba_bd': DATABASE_WIDE });
    const res = await runMigrationsForSubscription(subscription.id, actor, { prismaDir: dir, republish: false, lockTimeoutMs: 1500, lockTimeoutMode: 'database' });
    expect(res.error).toBeNull();
    expect(res.status).toBe('SUCCEEDED');
    expect(await queryScratch(DB, `SELECT 1 FROM pg_db_role_setting WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())`)).toHaveLength(0);
  });
});

// H-247: `redactUrls` solo enmascaraba `postgres(ql)://…`, pero los errores de Prisma (P1000, P1001, P1003) nombran el servidor, el usuario y la base en TEXTO, entre comillas invertidas. Esa salida
// (`slice(-200)`) se enseña a quien tenga `migrations:run` (OPERATOR) y parte acaba en `meta.error` de la auditoría, visible a VIEWER; el host y el usuario de la BD de un cliente solo debe verlos SUPERADMIN.
describe('redactUrls oculta también el host, el usuario y la base de los errores de Prisma (H-247)', () => {
  it.each([
    ['P1001', "Error: P1001: Can't reach database server at `ep-cool-mouse-123456.eu-central-1.aws.neon.tech:5432`\n\nPlease make sure your database server is running at `ep-cool-mouse-123456.eu-central-1.aws.neon.tech`:`5432`.", ['ep-cool-mouse-123456', 'neon.tech', '5432']],
    ['P1000', 'Error: P1000: Authentication failed against database server at `db.cliente-secreto.internal`, the provided database credentials for `usuario_secreto` are not valid.', ['cliente-secreto', 'usuario_secreto']],
    ['P1003', 'Error: P1003: Database `bd_del_cliente` does not exist on the database server at `10.0.0.5:5432`.', ['bd_del_cliente', '10.0.0.5']],
    ['P1010', 'Error: P1010: User `usuario_secreto` was denied access on the database `bd_del_cliente`', ['usuario_secreto', 'bd_del_cliente']],
  ])('%s: no queda ni host, ni usuario, ni base', (_code, text, secretos) => {
    const out = redactUrls(text);
    for (const secreto of secretos) expect(out, secreto).not.toContain(secreto);
    expect(out).toContain('[oculto]');
    expect(out).toContain(_code); // el código del error sí se conserva: sirve para diagnosticar
  });

  it('las cadenas de conexión de siempre siguen ocultas y un texto sin datos de conexión no cambia', () => {
    expect(redactUrls('falló postgresql://u:p@host.neon.tech/db?sslmode=require y algo más')).toBe('falló postgresql://[oculto] y algo más');
    expect(redactUrls('Migration name: 20261101_algo\nTodo bien')).toBe('Migration name: 20261101_algo\nTodo bien');
  });
});
