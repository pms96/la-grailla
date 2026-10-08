import { describe, expect, it } from 'vitest';
import { deriveCronSecret, isSchemaAtLeast, migrationStamp, missingOnboarding, parseMasterKey, generateMasterKey } from '../src';

const A = '01JAAAAAAAAAAAAAAAAAAAAAAA';
const B = '01JBBBBBBBBBBBBBBBBBBBBBBB';

describe('deriveCronSecret', () => {
  const master = parseMasterKey(generateMasterKey());

  it('es determinista y distinto por cliente', async () => {
    expect(await deriveCronSecret(master, A)).toBe(await deriveCronSecret(master, A));
    expect(await deriveCronSecret(master, A)).not.toBe(await deriveCronSecret(master, B));
  });

  it('cambia con el maestro y es base64url de 32 bytes', async () => {
    const other = parseMasterKey(generateMasterKey());
    const s = await deriveCronSecret(master, A);
    expect(s).not.toBe(await deriveCronSecret(other, A));
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('versión de esquema', () => {
  it('extrae la marca de tiempo del nombre de la migración', () => {
    expect(migrationStamp('20261008213000_contact_inbox')).toBe('20261008213000');
    expect(migrationStamp('migration_lock.toml')).toBeNull();
    expect(migrationStamp(null)).toBeNull();
  });

  it('compara por marca de tiempo; ilegible o ausente en la BD NO cuenta como al día', () => {
    const min = '20261008213000_contact_inbox';
    expect(isSchemaAtLeast('20261008213000_contact_inbox', min)).toBe(true);
    expect(isSchemaAtLeast('20261101000000_otra', min)).toBe(true);
    expect(isSchemaAtLeast('20260930110333_add_ingreso_model', min)).toBe(false);
    expect(isSchemaAtLeast(null, min)).toBe(false);
    expect(isSchemaAtLeast('basura', min)).toBe(false);
  });

  it('sin exigencia mínima (o ilegible) no se corta a nadie', () => {
    expect(isSchemaAtLeast(null, null)).toBe(true);
    expect(isSchemaAtLeast('20260101000000_x', undefined)).toBe(true);
    expect(isSchemaAtLeast('20260101000000_x', 'basura')).toBe(true);
  });
});

describe('missingOnboarding', () => {
  const ok = { admin_email: 'dueno@cliente.es', legal_notice: 'a', privacy_policy: 'b', cookies_policy: 'c' };

  it('completo = nada que falte', () => {
    expect(missingOnboarding(ok)).toEqual([]);
  });

  it('lista lo que falta; los espacios y un correo malformado no cuentan', () => {
    expect(missingOnboarding({})).toEqual(['admin_email', 'legal_notice', 'privacy_policy', 'cookies_policy']);
    expect(missingOnboarding({ ...ok, privacy_policy: '   ' })).toEqual(['privacy_policy']);
    expect(missingOnboarding({ ...ok, admin_email: 'no-es-un-correo' })).toEqual(['admin_email']);
  });
});
