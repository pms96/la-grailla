import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let sessionRole: 'ADMIN' | null = 'ADMIN';
vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => (sessionRole ? { user: { id: 'admin-ingresos-test', role: sessionRole } } : null)),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

const { GET: listIngresos, POST: createIngreso } = await import('@/app/api/admin/ingresos/route');
const { PATCH: updateIngreso, DELETE: deleteIngreso } = await import('@/app/api/admin/ingresos/[id]/route');

function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

// AUDIT: la caja física de la caseta (entradas en puerta, barra...) no tenía
// dónde registrarse — el balance de la temporada solo podía calcularse a
// partir de entradas online y patrocinios, nunca del dinero real contado
// cada noche.
describe('CRUD /api/admin/ingresos', () => {
  let temporadaId: string;

  beforeAll(async () => {
    // createdById es una FK real a User — el admin de la sesión mockeada
    // necesita existir en BD o el POST falla con un P2003 (violación de FK).
    await prisma.user.upsert({
      where: { id: 'admin-ingresos-test' },
      update: {},
      create: { id: 'admin-ingresos-test', email: 'admin-ingresos-test@example.com', role: 'ADMIN' },
    });
    const temporada = await prisma.temporada.create({ data: { nombre: '[TEST] Temporada ingresos', anio: 2098 } });
    temporadaId = temporada.id;
  });

  afterAll(async () => {
    await prisma.ingreso.deleteMany({ where: { temporadaId } });
    await prisma.temporada.delete({ where: { id: temporadaId } });
    await prisma.user.delete({ where: { id: 'admin-ingresos-test' } }).catch(() => {});
  });

  it('rechaza a quien no es admin', async () => {
    sessionRole = null;
    const res = await createIngreso(jsonRequest('http://localhost', 'POST', { temporadaId, concepto: 'Entradas', importe: 100 }));
    expect(res.status).toBe(401);
    sessionRole = 'ADMIN';
  });

  it('crea un ingreso con la fecha e importe indicados', async () => {
    const res = await createIngreso(
      jsonRequest('http://localhost', 'POST', { temporadaId, concepto: 'Entradas', importe: 320.5, fecha: '2026-09-25', notas: 'Viernes noche' })
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.concepto).toBe('Entradas');
    expect(data.importe).toBe(320.5);
    expect(data.notas).toBe('Viernes noche');
  });

  it('lista los ingresos de la temporada ordenados por fecha', async () => {
    await createIngreso(jsonRequest('http://localhost', 'POST', { temporadaId, concepto: 'Barra', importe: 210, fecha: '2026-09-26' }));
    const res = await listIngresos(new Request(`http://localhost?temporadaId=${temporadaId}`));
    const data = await res.json();
    expect(data.length).toBeGreaterThanOrEqual(2);
    expect(new Date(data[0].fecha).getTime()).toBeLessThanOrEqual(new Date(data[data.length - 1].fecha).getTime());
  });

  it('edita un ingreso existente', async () => {
    const created = await createIngreso(jsonRequest('http://localhost', 'POST', { temporadaId, concepto: 'Otros', importe: 50, fecha: '2026-09-27' }));
    const { id } = await created.json();

    const res = await updateIngreso(jsonRequest('http://localhost', 'PATCH', { importe: 75 }), { params: { id } });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.importe).toBe(75);
  });

  it('elimina un ingreso', async () => {
    const created = await createIngreso(jsonRequest('http://localhost', 'POST', { temporadaId, concepto: 'Comida', importe: 40, fecha: '2026-09-27' }));
    const { id } = await created.json();

    const res = await deleteIngreso(jsonRequest('http://localhost', 'DELETE'), { params: { id } });
    expect(res.status).toBe(200);

    const found = await prisma.ingreso.findUnique({ where: { id } });
    expect(found).toBeNull();
  });
});
