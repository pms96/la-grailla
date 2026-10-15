import { describe, expect, it } from 'vitest';
import { assertLocalTestDatabase, nonLocalDatabaseVars } from '../helpers/require-local-db';

/* La suite principal borra y crea datos: se niega a arrancar contra una base de datos que no sea local. */

const LOCAL = 'postgresql://lagrailla:lagrailla@localhost:5432/lagrailla';
const REMOTE = 'postgresql://neondb_owner:contrasena-secreta-123@ep-cool-name-123456.eu-west-2.aws.neon.tech/neondb?sslmode=require';

describe('guardia de la suite: solo bases de datos locales', () => {
  it('con las dos URLs locales no hace nada', () => {
    expect(() => assertLocalTestDatabase({ DATABASE_URL: LOCAL, DIRECT_URL: 'postgresql://u:p@127.0.0.1:5432/db' })).not.toThrow();
  });

  it('con una URL remota se niega, nombrando solo la variable', () => {
    expect(() => assertLocalTestDatabase({ DATABASE_URL: REMOTE, DIRECT_URL: LOCAL })).toThrow(/DATABASE_URL no apunta a una base de datos local/);
  });

  it('también vigila la URL directa, aunque la principal sea local', () => {
    expect(nonLocalDatabaseVars({ DATABASE_URL: LOCAL, DIRECT_URL: REMOTE })).toEqual(['DIRECT_URL']);
    expect(() => assertLocalTestDatabase({ DATABASE_URL: LOCAL, DIRECT_URL: REMOTE })).toThrow(/DIRECT_URL/);
  });

  it('si son remotas las dos, las nombra a las dos', () => {
    expect(() => assertLocalTestDatabase({ DATABASE_URL: REMOTE, DIRECT_URL: REMOTE })).toThrow(/DATABASE_URL y DIRECT_URL no apuntan/);
  });

  it('el mensaje de error NO contiene la URL, ni el host, ni la contraseña (son secretos)', () => {
    let message = '';
    try {
      assertLocalTestDatabase({ DATABASE_URL: REMOTE });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('contrasena-secreta-123');
    expect(message).not.toContain('neon.tech');
    expect(message).not.toContain('neondb_owner');
  });

  it('una URL inválida cuenta como remota (ante la duda, no se corre)', () => {
    expect(nonLocalDatabaseVars({ DATABASE_URL: 'esto-no-es-una-url' })).toEqual(['DATABASE_URL']);
  });

  it('no se deja engañar por «localhost» en el usuario o en la ruta', () => {
    expect(nonLocalDatabaseVars({ DATABASE_URL: 'postgresql://localhost:pass@remoto.example.com:5432/db' })).toEqual(['DATABASE_URL']);
    expect(nonLocalDatabaseVars({ DATABASE_URL: 'postgresql://u:p@remoto.example.com:5432/localhost' })).toEqual(['DATABASE_URL']);
  });

  it('una variable sin definir no es un error de esta guardia (la suite fallará por otro lado)', () => {
    expect(nonLocalDatabaseVars({})).toEqual([]);
  });
});
