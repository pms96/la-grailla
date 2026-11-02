import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { ForbiddenError } from '@/lib/permissions';
import { ABSOLUTE_TIMEOUT_MS, IDLE_TIMEOUT_MS, getSession, hashToken } from '@/lib/session';
import {
  LOCK_MS,
  MAX_FAILED_LOGINS,
  MAX_FAILED_LOGINS_ACCOUNT,
  unlockOperator,
  changePassword,
  completeTotpSetup,
  createOperator,
  loginWithPassword,
  resetOperatorCredentials,
  setOperatorDisabled,
  setOperatorRole,
  startTotpSetup,
  verifyMfa,
} from '@/lib/services/auth';
import { totpCode, totpStep } from '@/lib/totp';
import { makeOperator, resetControlDb, uniq } from './helpers';

beforeEach(resetControlDb);

const ctx = { ip: '203.0.113.7', userAgent: 'vitest' };

/** Hasta cuándo está bloqueada ESA IP para esa cuenta (H-170: el bloqueo es por cuenta Y por IP); null si no lo está. */
async function bucketLockedUntil(operatorId: string, ip: string): Promise<Date | null> {
  const row = await prisma.operatorLoginBucket.findUnique({ where: { operatorId_ip: { operatorId, ip } } });
  return row?.lockedUntil ?? null;
}
const NEW_PASSWORD = 'caballo-bateria-grapa-91';
let clock = 1_800_000_000_000;
const tick = (ms = 31_000) => (clock += ms); // cada paso avanza más de un intervalo TOTP

/** Alta completa: SUPERADMIN crea un operador y este recorre el primer acceso hasta tener TOTP. */
async function onboardedOperator(role: 'OPERATOR' | 'VIEWER' | 'SUPERADMIN' = 'OPERATOR') {
  const { actor: root } = await makeOperator('SUPERADMIN');
  const email = `nuevo-${uniq()}@test.local`;
  const { operator, temporaryPassword } = await createOperator({ email, name: 'Nuevo Operador', role }, root);

  const login = await loginWithPassword(email, temporaryPassword, ctx, tick());
  if (login.status !== 'mfa_required') throw new Error('login falló');
  expect(login.mustChangePassword).toBe(true);
  await changePassword(login.token, temporaryPassword, NEW_PASSWORD, ctx, tick());
  const { secret } = await startTotpSetup(login.token, tick());
  const now = tick();
  const done = await completeTotpSetup(login.token, totpCode(secret, totpStep(now)), ctx, now);
  if (done.status !== 'ok') throw new Error('setup falló');
  return { root, operator, email, secret, token: done.token, recoveryCodes: done.recoveryCodes };
}

describe('primer acceso', () => {
  it('contraseña temporal → cambio obligatorio → TOTP → sesión completa', async () => {
    const { operator, token, recoveryCodes } = await onboardedOperator();
    const live = await getSession(token, clock);
    expect(live?.mfaVerified).toBe(true);
    expect(live?.operator.id).toBe(operator.id);
    expect(recoveryCodes).toHaveLength(10);
    const fresh = await prisma.operator.findUniqueOrThrow({ where: { id: operator.id } });
    expect(fresh.mustChangePassword).toBe(false);
    expect(fresh.totpEnabledAt).not.toBeNull();
    // El secreto TOTP y los códigos no están en claro en la BD.
    expect(fresh.totpSecretEnc!.startsWith('enc:v2:')).toBe(true);
    expect(fresh.recoveryCodeHashes.every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
  });

  it('no se puede activar el TOTP sin cambiar antes la contraseña temporal', async () => {
    const { actor: root } = await makeOperator('SUPERADMIN');
    const email = `n-${uniq()}@test.local`;
    const { temporaryPassword } = await createOperator({ email, name: 'Nuevo', role: 'OPERATOR' }, root);
    const login = await loginWithPassword(email, temporaryPassword, ctx, tick());
    if (login.status !== 'mfa_required') throw new Error();
    await expect(startTotpSetup(login.token, tick())).rejects.toMatchObject({ code: 'password_change_required' });
  });

  it('rechaza una contraseña nueva débil, igual a la anterior, o con la actual mal', async () => {
    const { actor: root } = await makeOperator('SUPERADMIN');
    const email = `n-${uniq()}@test.local`;
    const { temporaryPassword } = await createOperator({ email, name: 'Nuevo', role: 'OPERATOR' }, root);
    const login = await loginWithPassword(email, temporaryPassword, ctx, tick());
    if (login.status !== 'mfa_required') throw new Error();
    await expect(changePassword(login.token, temporaryPassword, 'corta', ctx, tick())).rejects.toMatchObject({ code: 'weak_password' });
    await expect(changePassword(login.token, temporaryPassword, temporaryPassword, ctx, tick())).rejects.toMatchObject({ code: 'same_password' });
    await expect(changePassword(login.token, 'otra-cosa', NEW_PASSWORD, ctx, tick())).rejects.toMatchObject({ code: 'invalid_password' });
  });
});

describe('inicio de sesión', () => {
  it('contraseña + TOTP da una sesión nueva (token distinto al previo) y el token previo deja de valer', async () => {
    const { email, secret } = await onboardedOperator();
    const login = await loginWithPassword(email, NEW_PASSWORD, ctx, tick());
    if (login.status !== 'mfa_required') throw new Error();
    expect((await getSession(login.token, clock))?.mfaVerified).toBe(false); // solo contraseña: no es sesión completa
    const now = tick();
    const res = await verifyMfa(login.token, totpCode(secret, totpStep(now)), ctx, now);
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.token).not.toBe(login.token);
    expect(await getSession(login.token, now)).toBeNull();
    expect((await getSession(res.token, now))?.mfaVerified).toBe(true);
  });

  it('la sesión en BD guarda solo el hash del token', async () => {
    const { token } = await onboardedOperator();
    expect(await prisma.operatorSession.count({ where: { tokenHash: token } })).toBe(0);
    expect(await prisma.operatorSession.count({ where: { tokenHash: hashToken(token) } })).toBe(1);
  });

  it('un código TOTP no se puede usar dos veces', async () => {
    const { email, secret } = await onboardedOperator();
    const now = tick();
    const code = totpCode(secret, totpStep(now));
    const a = await loginWithPassword(email, NEW_PASSWORD, ctx, now);
    const b = await loginWithPassword(email, NEW_PASSWORD, ctx, now);
    if (a.status !== 'mfa_required' || b.status !== 'mfa_required') throw new Error();
    expect((await verifyMfa(a.token, code, ctx, now)).status).toBe('ok');
    expect((await verifyMfa(b.token, code, ctx, now)).status).toBe('invalid');
  });

  it('un código de recuperación sirve una sola vez', async () => {
    const { email, recoveryCodes } = await onboardedOperator();
    const a = await loginWithPassword(email, NEW_PASSWORD, ctx, tick());
    if (a.status !== 'mfa_required') throw new Error();
    expect((await verifyMfa(a.token, recoveryCodes[0], ctx, tick())).status).toBe('ok');
    const b = await loginWithPassword(email, NEW_PASSWORD, ctx, tick());
    if (b.status !== 'mfa_required') throw new Error();
    expect((await verifyMfa(b.token, recoveryCodes[0].toLowerCase(), ctx, tick())).status).toBe('invalid');
    // Otro código distinto sí vale.
    const c = await loginWithPassword(email, NEW_PASSWORD, ctx, tick());
    if (c.status !== 'mfa_required') throw new Error();
    expect((await verifyMfa(c.token, recoveryCodes[1], ctx, tick())).status).toBe('ok');
  });

  it('el mismo código de recuperación usado a la vez solo entra una vez', async () => {
    const { email, recoveryCodes } = await onboardedOperator();
    const logins = await Promise.all([1, 2, 3].map(() => loginWithPassword(email, NEW_PASSWORD, ctx, tick())));
    const tokens = logins.map((l) => (l.status === 'mfa_required' ? l.token : ''));
    const results = await Promise.all(tokens.map((t) => verifyMfa(t, recoveryCodes[2], ctx, clock)));
    expect(results.filter((r) => r.status === 'ok')).toHaveLength(1);
  });

  it('la respuesta es la misma para email inexistente, contraseña mala y cuenta deshabilitada', async () => {
    const { email, root, operator } = await onboardedOperator();
    await setOperatorDisabled(operator.id, true, root);
    const unknown = await loginWithPassword(`no-existe-${uniq()}@test.local`, 'lo-que-sea-123456', ctx, tick());
    const wrong = await loginWithPassword(email, 'contraseña-incorrecta-1', ctx, tick());
    expect(unknown).toEqual({ status: 'invalid' });
    expect(wrong).toEqual({ status: 'invalid' });
  });

  it('los intentos con emails que no existen no escriben en la auditoría', async () => {
    const before = await prisma.auditLog.count();
    for (let i = 0; i < 5; i++) await loginWithPassword(`fantasma-${uniq()}@test.local`, 'lo-que-sea-123456', ctx, tick());
    expect(await prisma.auditLog.count()).toBe(before);
  });
});

describe('bloqueo por intentos', () => {
  it(`tras ${MAX_FAILED_LOGINS} fallos bloquea la cuenta aunque luego la contraseña sea correcta, y se libera pasado el tiempo`, async () => {
    const { email, secret } = await onboardedOperator();
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) expect(await loginWithPassword(email, 'mala-mala-mala-1', ctx, tick(1000))).toEqual({ status: 'invalid' });
    expect(await loginWithPassword(email, NEW_PASSWORD, ctx, tick(1000))).toEqual({ status: 'invalid' }); // bloqueada

    // H-170: el bloqueo es por (cuenta, IP): la de esta IP queda bloqueada; la cuenta en sí no (otra IP puede entrar).
    const op = await prisma.operator.findUniqueOrThrow({ where: { email } });
    expect(await bucketLockedUntil(op.id, ctx.ip)).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { operatorId: op.id, action: 'auth.locked' } })).toBe(1);

    const later = clock + LOCK_MS + 1000;
    const ok = await loginWithPassword(email, NEW_PASSWORD, ctx, later);
    if (ok.status !== 'mfa_required') throw new Error('debería poder entrar');
    expect((await verifyMfa(ok.token, totpCode(secret, totpStep(later)), ctx, later)).status).toBe('ok');
  });

  it('los fallos de MFA también cuentan y bloquean', async () => {
    const { email } = await onboardedOperator();
    const login = await loginWithPassword(email, NEW_PASSWORD, ctx, tick());
    if (login.status !== 'mfa_required') throw new Error();
    let last;
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) last = await verifyMfa(login.token, '000000', ctx, clock);
    expect(last).toEqual({ status: 'locked' });
    expect((await verifyMfa(login.token, '000000', ctx, clock)).status).toBe('locked');
  });
});

/* H-170 (fase 5): el bloqueo del login era POR CUENTA (5 fallos, 15 min) sin componente de IP: quien conociera el email de un operador, SUPERADMIN incluido, lo bloqueaba cada 15 min con
 * 5 peticiones y solo había `operator:unlock` por script. Ahora el cupo de 5 fallos es por (cuenta, IP): quien conoce el email solo se bloquea a SÍ MISMO. Para no perder la defensa contra
 * una fuerza bruta repartida entre muchas IPs, la cuenta tiene además un tope mayor (30 fallos en total) que sí la bloquea y se levanta con `unlockOperator` (script y panel). */
describe('bloqueo por cuenta y por IP (H-170)', () => {
  const attacker = { ip: '198.51.100.9', userAgent: 'atacante' };
  const owner = { ip: '203.0.113.50', userAgent: 'operador' };

  it('quien conoce el email NO bloquea al operador: sigue pudiendo entrar (contraseña y MFA) desde su IP', async () => {
    const { email, secret } = await onboardedOperator();
    for (let i = 0; i < MAX_FAILED_LOGINS * 4; i++) expect(await loginWithPassword(email, 'mala-mala-mala-1', attacker, tick(1000))).toEqual({ status: 'invalid' });
    const now = tick(); // un intervalo TOTP nuevo: el código del alta ya está usado
    const login = await loginWithPassword(email, NEW_PASSWORD, owner, now);
    if (login.status !== 'mfa_required') throw new Error('el operador debería poder entrar desde su IP');
    expect((await verifyMfa(login.token, totpCode(secret, totpStep(now)), owner, now)).status).toBe('ok');
  });

  it('desde la IP bloqueada ni la contraseña correcta entra hasta pasado el tiempo', async () => {
    const { email } = await onboardedOperator();
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) await loginWithPassword(email, 'mala-mala-mala-1', attacker, tick(1000));
    expect(await loginWithPassword(email, NEW_PASSWORD, attacker, tick(1000))).toEqual({ status: 'invalid' });
    const later = clock + LOCK_MS + 1000;
    expect((await loginWithPassword(email, NEW_PASSWORD, attacker, later)).status).toBe('mfa_required');
  });

  it('martillear desde una IP ya bloqueada NO gasta el contador de la cuenta (no se llega al bloqueo de cuenta con una sola IP)', async () => {
    const { email } = await onboardedOperator();
    for (let i = 0; i < 200; i++) await loginWithPassword(email, 'mala-mala-mala-1', attacker, tick(10));
    const op = await prisma.operator.findUniqueOrThrow({ where: { email } });
    expect(op.lockedUntil).toBeNull();
    expect(op.failedLogins).toBeLessThanOrEqual(MAX_FAILED_LOGINS);
  });

  it('una fuerza bruta repartida entre muchas IPs SÍ bloquea la cuenta (defensa distribuida) y `unlockOperator` la levanta', async () => {
    const { email } = await onboardedOperator();
    const ips = Math.ceil(MAX_FAILED_LOGINS_ACCOUNT / MAX_FAILED_LOGINS) + 1;
    for (let n = 0; n < ips; n++) {
      for (let i = 0; i < MAX_FAILED_LOGINS; i++) await loginWithPassword(email, 'mala-mala-mala-1', { ip: `198.51.100.${100 + n}`, userAgent: 'botnet' }, tick(1000));
    }
    const op = await prisma.operator.findUniqueOrThrow({ where: { email } });
    expect(op.lockedUntil).not.toBeNull();
    expect(await loginWithPassword(email, NEW_PASSWORD, owner, tick(1000))).toEqual({ status: 'invalid' }); // la cuenta está bloqueada para todos
    await unlockOperator(op.id, { id: null, email: 'cli@servidor' });
    expect((await loginWithPassword(email, NEW_PASSWORD, owner, tick(1000))).status).toBe('mfa_required');
    expect(await prisma.operatorLoginBucket.count({ where: { operatorId: op.id } })).toBeLessThanOrEqual(1); // los cupos por IP también se limpian (queda el del acceso correcto, si acaso)
  });

  it('una contraseña correcta devuelve su intento al cupo de la IP (3 fallos + acceso + 1 fallo más no bloquean; el MFA sigue contando el suyo)', async () => {
    const { email } = await onboardedOperator();
    for (let i = 0; i < MAX_FAILED_LOGINS - 2; i++) await loginWithPassword(email, 'mala-mala-mala-1', owner, tick(1000));
    expect((await loginWithPassword(email, NEW_PASSWORD, owner, tick(1000))).status).toBe('mfa_required'); // no completa el MFA
    await loginWithPassword(email, 'mala-mala-mala-1', owner, tick(1000));
    expect((await loginWithPassword(email, NEW_PASSWORD, owner, tick(1000))).status).toBe('mfa_required'); // 4 fallos en el cupo, no 5
  });

  it('un acceso correcto limpia el cupo de esa IP y el contador de la cuenta', async () => {
    const { email, secret } = await onboardedOperator();
    for (let i = 0; i < MAX_FAILED_LOGINS - 2; i++) await loginWithPassword(email, 'mala-mala-mala-1', owner, tick(1000));
    const now = tick();
    const login = await loginWithPassword(email, NEW_PASSWORD, owner, now);
    if (login.status !== 'mfa_required') throw new Error();
    expect((await verifyMfa(login.token, totpCode(secret, totpStep(now)), owner, now)).status).toBe('ok');
    const op = await prisma.operator.findUniqueOrThrow({ where: { email } });
    expect(op.failedLogins).toBe(0);
    expect(await prisma.operatorLoginBucket.findUnique({ where: { operatorId_ip: { operatorId: op.id, ip: owner.ip } } })).toBeNull();
  });

  it('el MFA tiene su cupo por IP: quien tiene la contraseña pero no el código se bloquea él, no al operador', async () => {
    const { email, secret } = await onboardedOperator();
    const stolen = await loginWithPassword(email, NEW_PASSWORD, attacker, tick(1000)); // contraseña robada, sin el segundo factor
    if (stolen.status !== 'mfa_required') throw new Error();
    let last;
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) last = await verifyMfa(stolen.token, '000000', attacker, clock);
    expect(last).toEqual({ status: 'locked' });
    const now = tick();
    const login = await loginWithPassword(email, NEW_PASSWORD, owner, now);
    if (login.status !== 'mfa_required') throw new Error('el operador debería poder entrar');
    expect((await verifyMfa(login.token, totpCode(secret, totpStep(now)), owner, now)).status).toBe('ok');
  });
});

describe('caducidad de sesión', () => {
  it('sigue viva justo antes del límite de inactividad', async () => {
    const { token } = await onboardedOperator();
    expect(await getSession(token, clock + IDLE_TIMEOUT_MS - 1000)).not.toBeNull();
  });

  it('caduca pasado el límite de inactividad y la sesión se borra', async () => {
    const { token } = await onboardedOperator();
    expect(await getSession(token, clock + IDLE_TIMEOUT_MS + 61_000)).toBeNull();
    expect(await prisma.operatorSession.count({ where: { tokenHash: hashToken(token) } })).toBe(0);
  });

  it('el tiempo total no se alarga por seguir activo', async () => {
    const { token } = await onboardedOperator();
    const start = clock;
    let t = start;
    while (t < start + ABSOLUTE_TIMEOUT_MS - 60_000) {
      t += 20 * 60_000; // actividad cada 20 min mantiene viva la sesión por inactividad
      if (t >= start + ABSOLUTE_TIMEOUT_MS) break;
      expect(await getSession(token, t)).not.toBeNull();
    }
    expect(await getSession(token, start + ABSOLUTE_TIMEOUT_MS + 1000)).toBeNull();
  });

  it('una sesión pre-MFA caduca a los 10 minutos', async () => {
    const { email } = await onboardedOperator();
    const login = await loginWithPassword(email, NEW_PASSWORD, ctx, tick());
    if (login.status !== 'mfa_required') throw new Error();
    expect(await getSession(login.token, clock + 11 * 60_000)).toBeNull();
  });

  it('deshabilitar a un operador cierra sus sesiones', async () => {
    const { operator, token, root } = await onboardedOperator();
    const { actor } = await makeOperator('SUPERADMIN');
    await setOperatorDisabled(operator.id, true, actor);
    expect(await getSession(token, clock)).toBeNull();
    expect(root).toBeDefined();
  });

  it('cambiar la contraseña cierra las demás sesiones y conserva la actual', async () => {
    const { email, secret } = await onboardedOperator();
    const now = tick();
    const mk = async () => {
      const l = await loginWithPassword(email, NEW_PASSWORD, ctx, now);
      if (l.status !== 'mfa_required') throw new Error();
      return l.token;
    };
    const other = await mk();
    const pre = await mk();
    const full = await verifyMfa(pre, totpCode(secret, totpStep(now)), ctx, now);
    if (full.status !== 'ok') throw new Error('MFA falló');
    await changePassword(full.token, NEW_PASSWORD, 'otra-clave-distinta-77', ctx, now);
    expect(await getSession(other, now)).toBeNull();
    expect(await getSession(full.token, now)).not.toBeNull();
  });

  it('con MFA activado, quien solo tiene la contraseña NO puede cambiarla', async () => {
    const { email, operator } = await onboardedOperator();
    const login = await loginWithPassword(email, NEW_PASSWORD, ctx, tick());
    if (login.status !== 'mfa_required') throw new Error();
    await expect(changePassword(login.token, NEW_PASSWORD, 'clave-del-atacante-55', ctx, clock)).rejects.toMatchObject({ code: 'mfa_required' });
    // La contraseña sigue siendo la buena y el dueño puede entrar.
    expect((await loginWithPassword(email, NEW_PASSWORD, ctx, tick())).status).toBe('mfa_required');
    expect(operator.id).toBeTruthy();
  });
});

describe('gestión de operadores', () => {
  it('solo SUPERADMIN gestiona operadores', async () => {
    const { actor } = await makeOperator('OPERATOR');
    await expect(createOperator({ email: 'x@y.zz', name: 'Xx', role: 'VIEWER' }, actor)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('no deja deshabilitar ni degradar al último superadministrador', async () => {
    const { actor, op } = await makeOperator('SUPERADMIN');
    await expect(setOperatorDisabled(op.id, true, actor)).rejects.toMatchObject({ code: 'last_superadmin' });
    await expect(setOperatorRole(op.id, 'VIEWER', actor)).rejects.toMatchObject({ code: 'last_superadmin' });
    const { actor: second } = await makeOperator('SUPERADMIN');
    await setOperatorRole(op.id, 'VIEWER', second);
    expect((await prisma.operator.findUniqueOrThrow({ where: { id: op.id } })).role).toBe('VIEWER');
  });

  it('rechaza emails inválidos o repetidos', async () => {
    const { actor } = await makeOperator('SUPERADMIN');
    await expect(createOperator({ email: 'no-es-email', name: 'Xx', role: 'VIEWER' }, actor)).rejects.toMatchObject({ code: 'invalid_email' });
    const email = `dup-${uniq()}@test.local`;
    await createOperator({ email, name: 'Primero', role: 'VIEWER' }, actor);
    await expect(createOperator({ email: email.toUpperCase(), name: 'Segundo', role: 'VIEWER' }, actor)).rejects.toMatchObject({ code: 'email_taken' });
  });

  it('reiniciar credenciales borra el MFA, exige cambio de contraseña y cierra sesiones; la auditoría no lleva la clave temporal', async () => {
    const { operator, token } = await onboardedOperator();
    const { actor } = await makeOperator('SUPERADMIN');
    const { temporaryPassword } = await resetOperatorCredentials(operator.id, actor);
    expect(await getSession(token, clock)).toBeNull();
    const op = await prisma.operator.findUniqueOrThrow({ where: { id: operator.id } });
    expect(op).toMatchObject({ mustChangePassword: true, totpEnabledAt: null, totpSecretEnc: null });
    const entry = await prisma.auditLog.findFirst({ where: { action: 'operator.reset_credentials', targetId: operator.id } });
    expect(JSON.stringify(entry!.meta)).not.toContain(temporaryPassword);
  });

  it('la contraseña temporal no aparece en la auditoría de la creación', async () => {
    const { actor } = await makeOperator('SUPERADMIN');
    const { temporaryPassword, operator } = await createOperator({ email: `a-${uniq()}@test.local`, name: 'Alta', role: 'VIEWER' }, actor);
    const entries = await prisma.auditLog.findMany({ where: { targetId: operator.id } });
    expect(JSON.stringify(entries.map((e) => e.meta))).not.toContain(temporaryPassword);
  });
});

describe('fuerza bruta en paralelo', () => {
  it('una ráfaga de códigos MFA simultáneos no prueba más de MAX_FAILED_LOGINS códigos', async () => {
    const { email } = await onboardedOperator();
    const login = await loginWithPassword(email, NEW_PASSWORD, ctx, tick());
    if (login.status !== 'mfa_required') throw new Error();
    const burst = await Promise.all(Array.from({ length: 40 }, () => verifyMfa(login.token, '000000', ctx, clock)));
    // Solo los intentos que reservaron hueco antes de comprobar el código llegan a verificarse.
    expect(burst.filter((r) => r.status === 'invalid').length + burst.filter((r) => r.status === 'locked').length).toBe(40);
    expect(burst.filter((r) => r.status === 'invalid').length).toBeLessThan(MAX_FAILED_LOGINS);
    const op = await prisma.operator.findUniqueOrThrow({ where: { email } });
    expect(await bucketLockedUntil(op.id, ctx.ip)).not.toBeNull(); // H-170: bloqueo por (cuenta, IP)
  });

  it('una ráfaga de contraseñas simultáneas tampoco evita el bloqueo', async () => {
    const { email } = await onboardedOperator();
    await Promise.all(Array.from({ length: 30 }, () => loginWithPassword(email, 'mala-mala-mala-1', ctx, clock)));
    const op = await prisma.operator.findUniqueOrThrow({ where: { email } });
    expect(await bucketLockedUntil(op.id, ctx.ip)).not.toBeNull(); // H-170: bloqueo por (cuenta, IP)
    // Y la auditoría no se infla: solo se anotan los intentos que llegaron a verificarse.
    const entries = await prisma.auditLog.count({ where: { operatorId: op.id, action: { in: ['auth.login_failed', 'auth.locked'] } } });
    expect(entries).toBeLessThanOrEqual(MAX_FAILED_LOGINS);
  });

  it('un código TOTP correcto sigue funcionando tras fallos previos y limpia el contador', async () => {
    const { email, secret } = await onboardedOperator();
    for (let i = 0; i < MAX_FAILED_LOGINS - 2; i++) await loginWithPassword(email, 'mala-mala-mala-1', ctx, tick(1000));
    const now = tick();
    const login = await loginWithPassword(email, NEW_PASSWORD, ctx, now);
    if (login.status !== 'mfa_required') throw new Error();
    expect((await verifyMfa(login.token, totpCode(secret, totpStep(now)), ctx, now)).status).toBe('ok');
    expect((await prisma.operator.findUniqueOrThrow({ where: { email } })).failedLogins).toBe(0);
  });
});

describe('carreras en cuentas', () => {
  it('dos códigos de recuperación distintos usados a la vez se consumen los dos (ninguno resucita)', async () => {
    const { email, recoveryCodes, operator } = await onboardedOperator();
    const logins = await Promise.all([1, 2].map(() => loginWithPassword(email, NEW_PASSWORD, ctx, tick())));
    const tokens = logins.map((l) => (l.status === 'mfa_required' ? l.token : ''));
    const results = await Promise.all([verifyMfa(tokens[0], recoveryCodes[0], ctx, clock), verifyMfa(tokens[1], recoveryCodes[1], ctx, clock)]);
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok']);
    const op = await prisma.operator.findUniqueOrThrow({ where: { id: operator.id } });
    expect(op.recoveryCodeHashes).toHaveLength(8);
  });

  it('dos superadmins que se quitan el rol a la vez: solo uno lo consigue', async () => {
    const { actor: a, op: opA } = await makeOperator('SUPERADMIN');
    const { actor: b, op: opB } = await makeOperator('SUPERADMIN');
    const results = await Promise.allSettled([setOperatorRole(opB.id, 'VIEWER', a), setOperatorRole(opA.id, 'VIEWER', b)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.operator.count({ where: { role: 'SUPERADMIN', disabledAt: null } })).toBe(1);
  });
});
