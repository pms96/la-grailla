import { describe, it, expect, beforeEach } from 'vitest';
import { GENESIS_HASH, appendAudit, assertNoSecrets, checkRows, hashEntry, recordAudit, stableStringify, verifyAuditChain, type AuditRow } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { makeOperator, resetControlDb, uniq } from './helpers';

beforeEach(resetControlDb);

function chain(n: number): AuditRow[] {
  const rows: AuditRow[] = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= n; i++) {
    const f = { at: new Date(1_800_000_000_000 + i).toISOString(), operatorId: 'o', operatorEmail: 'a@b.c', action: `act.${i}`, targetType: 't', targetId: `${i}`, tenantId: null, ip: '203.0.113.9', userAgent: 'ua', meta: { i } };
    const hash = hashEntry(prev, f);
    rows.push({ id: BigInt(i), at: new Date(f.at), operatorId: 'o', operatorEmail: 'a@b.c', action: f.action, targetType: 't', targetId: f.targetId, tenantId: null, ip: '203.0.113.9', userAgent: 'ua', meta: { i }, prevHash: prev, hash });
    prev = hash;
  }
  return rows;
}

describe('cadena de hashes', () => {
  it('una cadena íntegra verifica', () => {
    expect(checkRows(GENESIS_HASH, chain(5)).ok).toBe(true);
  });

  it('detecta una fila editada, borrada o reordenada', () => {
    const edited = chain(5);
    edited[2] = { ...edited[2], action: 'act.hackeado' };
    expect(checkRows(GENESIS_HASH, edited)).toMatchObject({ ok: false, brokenAtId: '3' });

    const deleted = chain(5);
    deleted.splice(1, 1);
    expect(checkRows(GENESIS_HASH, deleted)).toMatchObject({ ok: false, brokenAtId: '3', reason: 'prevHash no coincide' });

    const swapped = chain(5);
    [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
    expect(checkRows(GENESIS_HASH, swapped).ok).toBe(false);
  });

  it('la IP y el user-agent también están protegidos por la cadena', () => {
    const forged = chain(3);
    forged[1] = { ...forged[1], ip: '10.0.0.1' };
    expect(checkRows(GENESIS_HASH, forged)).toMatchObject({ ok: false, brokenAtId: '2' });
    const ua = chain(3);
    ua[2] = { ...ua[2], userAgent: 'otro' };
    expect(checkRows(GENESIS_HASH, ua)).toMatchObject({ ok: false, brokenAtId: '3' });
  });

  it('stableStringify no depende del orden de las claves', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(stableStringify({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }));
  });
});

describe('registro real en BD', () => {
  it('la cadena de la BD verifica tras varias escrituras concurrentes', async () => {
    const { actor } = await makeOperator('OPERATOR');
    await Promise.all(Array.from({ length: 10 }, (_, i) => recordAudit({ actor, action: 'test.concurrent', targetType: 'x', targetId: `${uniq()}-${i}`, meta: { i } })));
    const rep = await verifyAuditChain();
    expect(rep.ok).toBe(true);
    expect(rep.checked).toBeGreaterThanOrEqual(10);
  });

  it('la BD rechaza UPDATE, DELETE y TRUNCATE sobre la auditoría', async () => {
    const { actor } = await makeOperator('OPERATOR');
    await recordAudit({ actor, action: 'test.immutable', targetType: 'x', targetId: uniq() });
    await expect(prisma.auditLog.updateMany({ data: { action: 'manipulado' } })).rejects.toThrow(/solo inserción/);
    await expect(prisma.auditLog.deleteMany({})).rejects.toThrow(/solo inserción/);
    await expect(prisma.$executeRawUnsafe('TRUNCATE TABLE "AuditLog"')).rejects.toThrow(/solo inserción/);
  });

  it('una transacción que falla no deja entrada de auditoría', async () => {
    const { actor } = await makeOperator('OPERATOR');
    const id = uniq();
    await expect(
      prisma.$transaction(async (tx) => {
        await appendAudit(tx, { actor, action: 'test.rollback', targetType: 'x', targetId: id });
        throw new Error('fallo de negocio');
      })
    ).rejects.toThrow('fallo de negocio');
    expect(await prisma.auditLog.count({ where: { targetId: id } })).toBe(0);
  });
});

describe('defensa contra secretos en la auditoría', () => {
  it.each([
    [{ password: 'x' }],
    [{ nested: { totpSecret: 'x' } }],
    [{ db_url: 'x' }],
    [{ url: 'postgresql://u:p@h/db' }],
    [{ v: 'enc:v2:m1:a:b:c' }],
    [{ list: [{ recoveryCodes: [] }] }],
  ])('rechaza %j', (meta) => {
    expect(() => assertNoSecrets(meta)).toThrow();
  });

  it('acepta metadatos normales', () => {
    expect(() => assertNoSecrets({ host: 'a.es', modules: ['tienda'], seq: 3, how: 'dns' })).not.toThrow();
  });
});
