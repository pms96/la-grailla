import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { restoreConfigSnapshot, snapshotConfig } from '../helpers/fixtures';
import type { ConfigRow } from '../helpers/config-journal';

let sessionRole: 'ADMIN' | null = 'ADMIN';
vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => (sessionRole ? { user: { id: 'admin-mark-paid-test', role: sessionRole } } : null)),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { POST: markPaid } = await import('@/app/api/admin/sponsors-portal/[id]/mark-paid/route');

function postRequest(body: unknown): Request {
  return new Request('http://localhost', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// AUDIT: el importe de patrocinio pagado no se registraba en ningún sitio —
// esta ruta lo toma del precio configurado del tipo de patrocinio asignado
// (no lo escribe el admin a mano), y no bloquea ninguna acción del pipeline.
describe('POST /api/admin/sponsors-portal/[id]/mark-paid', () => {
  let requestId: string;
  let sponsorId: string;
  let temporadaId: string;
  // H-151: los tipos de patrocinio REALES se guardan (con diario) y se devuelven al terminar; antes `afterAll` los borraba.
  let savedTiers: ConfigRow[] = [];

  beforeAll(async () => {
    savedTiers = await snapshotConfig(['sponsor_tiers']);
    temporadaId = (await prisma.temporada.create({ data: { nombre: `[TEST] Temporada mark-paid ${Date.now()}`, anio: 2089 } })).id;
    // No depender de lo que ya hubiera guardado en Configuración — se fija un
    // tipo con un importe conocido para que el test no dependa del estado
    // compartido de la BD de dev.
    await prisma.appConfig.upsert({
      where: { key: 'sponsor_tiers' },
      update: { value: JSON.stringify([{ value: 'evento', label: 'Evento', priceLabel: '30€', priceAmount: 30 }]) },
      create: { key: 'sponsor_tiers', value: JSON.stringify([{ value: 'evento', label: 'Evento', priceLabel: '30€', priceAmount: 30 }]) },
    });

    const request = await prisma.sponsorRequest.create({
      data: {
        companyName: 'Marcar Pagado SL',
        contactName: 'Pat',
        email: `sponsor-mark-paid-${Date.now()}@example.com`,
        sponsorType: 'evento',
        status: 'ACCEPTED',
        temporadaId,
      },
    });
    requestId = request.id;
    const sponsor = await prisma.sponsor.create({ data: { sponsorRequestId: request.id } });
    sponsorId = sponsor.id;
  });

  afterAll(async () => {
    await prisma.sponsor.deleteMany({ where: { id: sponsorId } });
    await prisma.sponsorRequest.deleteMany({ where: { id: requestId } });
    await restoreConfigSnapshot(['sponsor_tiers'], savedTiers);
    await prisma.temporada.delete({ where: { id: temporadaId } }).catch(() => {});
  });

  it('rechaza a quien no es admin', async () => {
    sessionRole = null;
    const res = await markPaid(postRequest({ mode: 'paid' }), { params: Promise.resolve({ id: sponsorId }) });
    expect(res.status).toBe(401);
    sessionRole = 'ADMIN';
  });

  it('rechaza marcar como pagado si no hay tipo de patrocinio asignado', async () => {
    const request = await prisma.sponsorRequest.create({
      data: {
        companyName: 'Sin Tipo Pagado SL',
        contactName: 'Sin Tipo',
        email: `sponsor-sin-tipo-pagado-${Date.now()}@example.com`,
        status: 'ACCEPTED',
      },
    });
    const sponsor = await prisma.sponsor.create({ data: { sponsorRequestId: request.id } });
    const res = await markPaid(postRequest({ mode: 'paid' }), { params: Promise.resolve({ id: sponsor.id }) });
    expect(res.status).toBe(400);
    await prisma.sponsor.deleteMany({ where: { id: sponsor.id } });
    await prisma.sponsorRequest.deleteMany({ where: { id: request.id } });
  });

  it('marca como pagado tomando el importe del tipo de patrocinio asignado', async () => {
    const res = await markPaid(postRequest({ mode: 'paid' }), { params: Promise.resolve({ id: sponsorId }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.isPaid).toBe(true);
    expect(data.isCollaboration).toBe(false);
    expect(data.paidAmount).toBe(30);
    expect(data.paidAt).toBeTruthy();
  });

  it('no bloquea ninguna acción del pipeline: el status se mantiene intacto', async () => {
    const sponsor = await prisma.sponsor.findUnique({ where: { id: sponsorId } });
    expect(sponsor?.status).toBe('PENDIENTE_MATERIALES');
  });

  it('se puede desmarcar el pago', async () => {
    const res = await markPaid(postRequest({ mode: 'unpaid' }), { params: Promise.resolve({ id: sponsorId }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.isPaid).toBe(false);
    expect(data.isCollaboration).toBe(false);
    expect(data.paidAmount).toBeNull();
    expect(data.paidAt).toBeNull();
  });

  // AUDIT: una aportación en especie (producto/servicio en vez de dinero) no
  // tenía forma de registrarse — el admin solo podía marcarla como "pagado"
  // igual que un pago real, lo que inflaba ingresosPatrocinio en
  // /admin/gastos con dinero que nunca entró en la cuenta.
  it('marca como colaboración: desbloquea el portal (isPaid) pero queda distinguida de un pago real', async () => {
    const res = await markPaid(postRequest({ mode: 'collaboration' }), { params: Promise.resolve({ id: sponsorId }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.isPaid).toBe(true);
    expect(data.isCollaboration).toBe(true);
    expect(data.paidAmount).toBe(30);
    expect(data.paidAt).toBeTruthy();
  });

  it('desmarcar limpia también isCollaboration', async () => {
    const res = await markPaid(postRequest({ mode: 'unpaid' }), { params: Promise.resolve({ id: sponsorId }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.isPaid).toBe(false);
    expect(data.isCollaboration).toBe(false);
  });

  /* H-134: el ingreso por patrocinio era el precio de TARIFA, no lo cobrado: no se podía teclear el importe real (500 pactado, 600 de tarifa ⇒ contaba 600),
   * «500 € + IVA» se registraba 500 aunque se cobraran 605, sin `sponsor_tiers` regían los 30/50/75 € «de fábrica» (un cliente nuevo registraba ingresos
   * inventados), un tipo sin `priceAmount` se normalizaba a 0 y el patrocinio quedaba «Pagado» con 0 €, y sin temporada el ingreso no contaba en ninguna parte. */
  describe('importe cobrado (H-134)', () => {
    const ctx = () => ({ params: Promise.resolve({ id: sponsorId }) });
    const reset = () => markPaid(postRequest({ mode: 'unpaid' }), ctx());
    const setTiers = (value: string | null) =>
      value === null
        ? prisma.appConfig.deleteMany({ where: { key: 'sponsor_tiers' } })
        : prisma.appConfig.upsert({ where: { key: 'sponsor_tiers' }, update: { value }, create: { key: 'sponsor_tiers', value } });
    const tier30 = JSON.stringify([{ value: 'evento', label: 'Evento', priceLabel: '30€', priceAmount: 30 }]);

    it('el importe tecleado manda sobre la tarifa (500 pactado con 600 de tarifa cuenta 500; 605 con IVA cuenta 605)', async () => {
      await reset();
      const res = await markPaid(postRequest({ mode: 'paid', amount: 605 }), ctx());
      expect(res.status).toBe(200);
      expect((await res.json()).paidAmount).toBe(605);
      await reset();
    });

    it('sin importe tecleado se toma la tarifa, como hasta ahora', async () => {
      await reset();
      expect((await (await markPaid(postRequest({ mode: 'paid' }), ctx())).json()).paidAmount).toBe(30);
      await reset();
    });

    it('un importe 0, negativo o por encima del tope es una petición mal formada y no marca nada (tampoco como colaboración)', async () => {
      await reset();
      for (const amount of [0, -5, 1e12]) {
        expect((await markPaid(postRequest({ mode: 'paid', amount }), ctx())).status, String(amount)).toBe(400);
        expect((await markPaid(postRequest({ mode: 'collaboration', amount }), ctx())).status, `colaboración ${amount}`).toBe(400);
      }
      expect((await prisma.sponsor.findUniqueOrThrow({ where: { id: sponsorId } })).isPaid).toBe(false);
    });

    it('un tipo de patrocinio sin importe (priceAmount 0) no deja el patrocinio «Pagado» con 0 €: pide el importe', async () => {
      await setTiers(JSON.stringify([{ value: 'evento', label: 'Evento', priceLabel: 'a convenir' }]));
      try {
        const res = await markPaid(postRequest({ mode: 'paid' }), ctx());
        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe('importe_requerido');
        expect((await prisma.sponsor.findUniqueOrThrow({ where: { id: sponsorId } })).isPaid).toBe(false);
        // con el importe tecleado sí se puede
        expect((await markPaid(postRequest({ mode: 'paid', amount: 400 }), ctx())).status).toBe(200);
      } finally {
        await reset();
        await setTiers(tier30);
      }
    });

    it('sin tipos configurados NO se inventan los de fábrica (30/50/75 €): hay que teclear el importe', async () => {
      await setTiers(null);
      try {
        const res = await markPaid(postRequest({ mode: 'paid' }), ctx());
        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe('importe_requerido');
        expect((await markPaid(postRequest({ mode: 'paid', amount: 250 }), ctx())).status).toBe(200);
      } finally {
        await reset();
        await setTiers(tier30);
      }
    });

    it('un patrocinio sin temporada no se marca pagado: el ingreso no contaría en ninguna parte', async () => {
      const request = await prisma.sponsorRequest.create({ data: { companyName: 'Sin Temporada SL', contactName: 'X', email: `sin-temp-${Date.now()}@example.com`, sponsorType: 'evento', status: 'ACCEPTED' } });
      const sponsor = await prisma.sponsor.create({ data: { sponsorRequestId: request.id } });
      try {
        const res = await markPaid(postRequest({ mode: 'paid' }), { params: Promise.resolve({ id: sponsor.id }) });
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.code).toBe('temporada_requerida');
        expect(data.error).toContain('temporada');
        expect((await prisma.sponsor.findUniqueOrThrow({ where: { id: sponsor.id } })).isPaid).toBe(false);
        // una colaboración (en especie) no es ingreso: no necesita temporada
        expect((await markPaid(postRequest({ mode: 'collaboration' }), { params: Promise.resolve({ id: sponsor.id }) })).status).toBe(200);
      } finally {
        await prisma.sponsor.deleteMany({ where: { id: sponsor.id } });
        await prisma.sponsorRequest.deleteMany({ where: { id: request.id } });
      }
    });
  });
});
