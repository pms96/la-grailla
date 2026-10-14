import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { ForbiddenError } from '@/lib/permissions';
import { verifyDomainManually } from '@/lib/services/domains';
import { ServiceError } from '@/lib/services/errors';
import { inviteTenantAdmin } from '@/lib/services/invitations';
import { describeInvite, describeProvision, describeSeed } from '@/lib/services/lifecycle';
import { invitationEmail, mailerConfig, type OutgoingMail } from '@/lib/services/mailer';
import { runMigrationsForSubscription } from '@/lib/services/migrations';
import type { ProvisionResult } from '@/lib/services/provision';
import { seedExistingTenant } from '@/lib/services/tenant-setup';
import { createTenant } from '@/lib/services/tenants';
import { hashPasswordToken } from '../../../lib/platform/password-token';
import { freshStore, makeOperator, resetControlDb, tenantInput } from './helpers';
import { createScratchDb, dropScratchDb, queryScratch } from './scratch-db';

const DB_RAW = 'lagrailla_scratch_invite_raw';
const DB_READY = 'lagrailla_scratch_invite_ready';
const LEGAL = { legal_notice: 'Aviso legal.', privacy_policy: 'Privacidad.', cookies_policy: 'Cookies.' };

let actor: Awaited<ReturnType<typeof makeOperator>>['actor'];
let rawSub = '';
let readySub = '';
let readyTenant = '';
let readyHost = '';
let readyDomainId = '';

const sentMail: OutgoingMail[] = [];
const okMailer = async (m: OutgoingMail) => void sentMail.push(m);
const tokenFrom = (text: string) => new URL(text.match(/https:\/\/\S+/)![0]).searchParams.get('token')!;

beforeAll(async () => {
  await resetControlDb();
  freshStore();
  const urlRaw = await createScratchDb(DB_RAW);
  const urlReady = await createScratchDb(DB_READY);
  ({ actor } = await makeOperator('SUPERADMIN'));
  const raw = await createTenant(tenantInput({ dbUrlPooled: urlRaw, dbUrlDirect: urlRaw }) as never, actor);
  rawSub = raw.subscription.id;
  await verifyDomainManually(raw.domain.id, actor);
  const ready = await createTenant(tenantInput({ dbUrlPooled: urlReady, dbUrlDirect: urlReady, name: 'Peña <Los Tres> & Co' }) as never, actor);
  readySub = ready.subscription.id;
  readyTenant = ready.tenant.id;
  readyHost = ready.domain.host;
  readyDomainId = ready.domain.id;
  expect((await runMigrationsForSubscription(readySub, actor, { republish: false })).status).toBe('SUCCEEDED');
}, 180_000);
afterAll(async () => {
  await dropScratchDb(DB_RAW);
  await dropScratchDb(DB_READY);
}, 60_000);

describe('condiciones previas', () => {
  it('solo un superadmin; la BD migrada; un dominio verificado; y un administrador creado', async () => {
    const { actor: operator } = await makeOperator('OPERATOR');
    await expect(inviteTenantAdmin(readySub, {}, operator, { mailer: okMailer })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(inviteTenantAdmin(rawSub, {}, actor, { mailer: okMailer })).rejects.toMatchObject({ code: 'migrate_first' });
    await expect(inviteTenantAdmin(readySub, {}, actor, { mailer: okMailer })).rejects.toMatchObject({ code: 'no_verified_domain' });
    await verifyDomainManually(readyDomainId, actor);
    await expect(inviteTenantAdmin(readySub, {}, actor, { mailer: okMailer })).rejects.toMatchObject({ code: 'no_admin_user' });
    // Nada de lo anterior ha escrito ni mandado nada.
    expect(await queryScratch(DB_READY, 'SELECT 1 FROM "VerificationToken"')).toHaveLength(0);
    expect(sentMail).toHaveLength(0);
  });
});

describe('invitar', () => {
  beforeAll(async () => {
    // El administrador existe, con una contraseña aleatoria que nadie conoce (así lo crea el alta).
    await seedExistingTenant(readySub, { adminEmail: 'Dueno@Cliente.test', adminName: 'Dueño', legal: LEGAL }, actor);
  });

  it('con correo: lo envía al administrador con el enlace a la web del cliente y no devuelve el enlace', async () => {
    sentMail.length = 0;
    const res = await inviteTenantAdmin(readySub, {}, actor, { mailer: okMailer });
    expect(res).toMatchObject({ userEmail: 'dueno@cliente.test', host: readyHost, delivery: 'email' });
    expect(res.link).toBeUndefined();
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0].to).toBe('dueno@cliente.test');
    expect(sentMail[0].text).toContain(`https://${readyHost}/auth/establecer-contrasena?token=`);
    expect(sentMail[0].subject).not.toMatch(/[\r\n]/);
    // El nombre del cliente va escapado en el HTML.
    expect(sentMail[0].html).toContain('Peña &lt;Los Tres&gt; &amp; Co');
    expect(sentMail[0].html).not.toContain('<Los Tres>');
  });

  it('en la BD del cliente queda solo el hash, para ese usuario y con 72 horas de vida', async () => {
    sentMail.length = 0;
    const t0 = Date.now();
    await inviteTenantAdmin(readySub, {}, actor, { mailer: okMailer });
    const token = tokenFrom(sentMail[0].text);
    const rows = await queryScratch<{ identifier: string; token: string; expires: Date }>(DB_READY, 'SELECT * FROM "VerificationToken"');
    expect(rows).toHaveLength(1);
    expect(rows[0].identifier).toBe('pwset:dueno@cliente.test');
    expect(rows[0].token).toBe(hashPasswordToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    const ttl = new Date(rows[0].expires).getTime() - t0;
    expect(ttl).toBeGreaterThan(71.9 * 3600_000);
    expect(ttl).toBeLessThan(72.1 * 3600_000);
  });

  it('sin correo: devuelve el enlace para que lo pase el operador, y volver a invitar anula el anterior', async () => {
    sentMail.length = 0;
    await inviteTenantAdmin(readySub, {}, actor, { mailer: okMailer });
    const firstHash = hashPasswordToken(tokenFrom(sentMail[0].text));
    const res = await inviteTenantAdmin(readySub, {}, actor, { mailer: null });
    expect(res.delivery).toBe('link');
    expect(res.link).toMatch(new RegExp(`^https://${readyHost.replace(/\./g, '\\.')}/auth/establecer-contrasena\\?token=`));
    const rows = await queryScratch<{ token: string }>(DB_READY, 'SELECT token FROM "VerificationToken"');
    expect(rows).toHaveLength(1);
    expect(rows[0].token).toBe(hashPasswordToken(tokenFrom(res.link!)));
    expect(rows[0].token).not.toBe(firstHash);
  });

  it('si el envío falla cae al enlace manual sin filtrar el motivo del SMTP', async () => {
    const failing = async () => {
      throw new Error('535 auth failed for user smtp-secreto@proveedor.test');
    };
    const res = await inviteTenantAdmin(readySub, {}, actor, { mailer: failing });
    expect(res.delivery).toBe('link');
    expect(res.link).toBeTruthy();
    expect(res.mailError).toMatch(/No se pudo enviar el correo/);
    expect(JSON.stringify(res)).not.toMatch(/smtp-secreto|535/);
  });

  it('se puede elegir otro usuario existente (sin distinguir mayúsculas) y uno que no existe se rechaza', async () => {
    sentMail.length = 0;
    await expect(inviteTenantAdmin(readySub, { userEmail: 'nadie@cliente.test' }, actor, { mailer: okMailer })).rejects.toMatchObject({ code: 'no_admin_user' });
    const res = await inviteTenantAdmin(readySub, { userEmail: 'DUENO@cliente.TEST' }, actor, { mailer: okMailer });
    expect(res.userEmail).toBe('dueno@cliente.test');
  });

  it('deja constancia en la auditoría sin enlace, token ni correo', async () => {
    const rows = await prisma.auditLog.findMany({ where: { tenantId: readyTenant, action: 'tenant.invite' }, orderBy: { id: 'asc' } });
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.map((r) => (r.meta as { via: string }).via)).toEqual(expect.arrayContaining(['email', 'link']));
    const text = JSON.stringify(rows.map((r) => r.meta));
    expect(text).not.toMatch(/dueno@|token=|establecer-contrasena/);
  });
});

describe('cómo se cuenta', () => {
  const expiresAt = new Date('2026-10-20T10:00:00Z');

  it('por correo: sin enlace en ningún sitio', () => {
    const o = describeInvite({ userEmail: 'a@b.test', host: 'x.test', expiresAt, delivery: 'email' });
    expect(o.ok).toMatch(/Invitación enviada a a@b\.test/);
    expect(o.reveal).toBeUndefined();
    expect(o.error).toBeUndefined();
  });

  it('sin correo configurado: el enlace solo en «reveal»', () => {
    const o = describeInvite({ userEmail: 'a@b.test', host: 'x.test', expiresAt, delivery: 'link', link: 'https://x.test/auth/establecer-contrasena?token=ZZZ' });
    expect(o.ok).toMatch(/no tiene correo configurado/);
    expect(o.reveal!.lines).toEqual(['Para: a@b.test', 'https://x.test/auth/establecer-contrasena?token=ZZZ']);
    expect(JSON.stringify({ ...o, reveal: undefined })).not.toContain('ZZZ');
  });

  it('con el envío fallido: es un error y el enlace sigue disponible', () => {
    const o = describeInvite({ userEmail: 'a@b.test', host: 'x.test', expiresAt, delivery: 'link', link: 'https://x.test/p?token=QQQ', mailError: 'No se pudo enviar el correo (…)' });
    expect(o.error).toMatch(/No se pudo enviar/);
    expect(o.ok).toBeUndefined();
    expect(o.reveal!.lines[1]).toContain('QQQ');
  });

  it('el alta y los datos iniciales con «invitar» no enseñan la contraseña temporal', () => {
    const prov: ProvisionResult = { ok: true, tenantId: 't1', subscriptionId: 's1', host: 'a.test', steps: [], missing: [], published: true, adminPassword: 'Contr4señaTemporal' };
    expect(describeProvision(prov, { adminEmail: 'a@b.test', invite: true }).reveal).toBeUndefined();
    expect(describeProvision(prov, { adminEmail: 'a@b.test' }).reveal).toBeDefined();
    const seed = { configWritten: [], adminEmail: 'a@b.test', adminPassword: 'Secreta123', missing: [] };
    const s = describeSeed(seed, { invite: true });
    expect(s.reveal).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain('Secreta123');
    expect(s.details).toContain('Usuario administrador creado sin contraseña conocida: la fijará él mismo con la invitación.');
  });
});

describe('correo del panel', () => {
  it('sin las cuatro variables obligatorias, la función está desactivada', () => {
    expect(mailerConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(mailerConfig({ PANEL_SMTP_HOST: 'smtp.test', PANEL_SMTP_USER: 'u', PANEL_SMTP_PASSWORD: 'p' } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });

  it('con todas, lee puerto, TLS y remitente (sin saltos de línea ni comillas)', () => {
    const cfg = mailerConfig({ PANEL_SMTP_HOST: ' smtp.test ', PANEL_SMTP_USER: 'u', PANEL_SMTP_PASSWORD: 'p', PANEL_SMTP_FROM_EMAIL: 'no-reply@proveedor.test', PANEL_SMTP_PORT: '465', PANEL_SMTP_FROM_NAME: 'La "Grailla"\r\nBcc: x@y.test' } as unknown as NodeJS.ProcessEnv)!;
    expect(cfg).toMatchObject({ host: 'smtp.test', port: 465, secure: true, user: 'u', fromEmail: 'no-reply@proveedor.test' });
    expect(cfg.fromName).not.toMatch(/["\r\n]/);
    expect(mailerConfig({ PANEL_SMTP_HOST: 'h', PANEL_SMTP_USER: 'u', PANEL_SMTP_PASSWORD: 'p', PANEL_SMTP_FROM_EMAIL: 'a@b.test' } as unknown as NodeJS.ProcessEnv)).toMatchObject({ port: 587, secure: false, fromName: 'La Grailla' });
  });

  it('el correo no deja pasar HTML ni cabeceras del nombre del cliente', () => {
    const m = invitationEmail({ brandName: 'Bar "X"\r\nBcc: x@y.test <script>', link: 'https://c.test/auth/establecer-contrasena?token=abc', expiresAt: new Date('2026-10-20T10:00:00Z') });
    expect(m.subject).not.toMatch(/[\r\n"]/);
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('href="https://c.test/auth/establecer-contrasena?token=abc"');
    expect(m.text).toContain('caduca el');
  });
});

describe('errores tipados', () => {
  it('los de servicio llevan un código estable', async () => {
    await expect(inviteTenantAdmin('no-existe', {}, actor, { mailer: null })).rejects.toBeInstanceOf(ServiceError);
  });
});
