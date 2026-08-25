import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import bcrypt from 'bcryptjs';

let currentSessionUserId = '';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({
    user: { id: currentSessionUserId, role: 'ADMIN', email: 'admin-session@test.local' },
  })),
}));

vi.mock('@/lib/auth', () => ({
  authOptions: {},
}));

const { PUT: updateUser, DELETE: deleteUser } = await import('@/app/api/admin/users/[id]/route');

function jsonRequest(body: unknown) {
  return new Request('http://localhost/api/admin/users/x', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PUT/DELETE /api/admin/users/[id]', () => {
  let adminId: string;
  let otherAdminId: string;
  let taquillaId: string;

  beforeAll(async () => {
    const suffix = Date.now();
    const admin = await prisma.user.create({
      data: { email: `admin-a-${suffix}@test.local`, name: 'Admin A', hashedPassword: await bcrypt.hash('x', 4), role: 'ADMIN' },
    });
    adminId = admin.id;
    const admin2 = await prisma.user.create({
      data: { email: `admin-b-${suffix}@test.local`, name: 'Admin B', hashedPassword: await bcrypt.hash('x', 4), role: 'ADMIN' },
    });
    otherAdminId = admin2.id;
    const staff = await prisma.user.create({
      data: { email: `taquilla-c-${suffix}@test.local`, name: 'Staff C', hashedPassword: await bcrypt.hash('x', 4), role: 'TAQUILLA' },
    });
    taquillaId = staff.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [adminId, otherAdminId, taquillaId] } } });
  });

  // AUDIT: un admin podía quitarse a sí mismo el rol ADMIN o borrarse,
  // dejando el panel sin nadie con acceso. Severidad: Alto.
  it('rechaza que un admin se quite a sí mismo el rol de administrador', async () => {
    currentSessionUserId = adminId;
    const res = await updateUser(jsonRequest({ role: 'TAQUILLA' }), { params: { id: adminId } });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/no puedes/i);
    const stillAdmin = await prisma.user.findUnique({ where: { id: adminId } });
    expect(stillAdmin?.role).toBe('ADMIN');
  });

  it('rechaza que un admin se elimine a sí mismo', async () => {
    currentSessionUserId = adminId;
    const res = await deleteUser(new Request('http://localhost'), { params: { id: adminId } });
    expect(res.status).toBe(400);
    const stillExists = await prisma.user.findUnique({ where: { id: adminId } });
    expect(stillExists).not.toBeNull();
  });

  // La BD de dev real puede tener más admins aparte de los de este test, así
  // que "queda 1 admin" no se puede lograr solo con los usuarios de prueba
  // sin tocar cuentas reales — se simula con un spy sobre el recuento que
  // usa la ruta, dejando intacto el resto de la lógica real (sesión, target,
  // update/delete reales sobre los usuarios de test).
  it('rechaza quitar el rol ADMIN al último administrador', async () => {
    currentSessionUserId = taquillaId;
    const countSpy = vi.spyOn(prisma.user, 'count').mockResolvedValueOnce(1);
    try {
      const res = await updateUser(jsonRequest({ role: 'TAQUILLA' }), { params: { id: otherAdminId } });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/último administrador/i);
      const stillAdmin = await prisma.user.findUnique({ where: { id: otherAdminId } });
      expect(stillAdmin?.role).toBe('ADMIN');
    } finally {
      countSpy.mockRestore();
    }
  });

  it('rechaza eliminar al último administrador', async () => {
    currentSessionUserId = taquillaId;
    const countSpy = vi.spyOn(prisma.user, 'count').mockResolvedValueOnce(1);
    try {
      const res = await deleteUser(new Request('http://localhost'), { params: { id: otherAdminId } });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/último administrador/i);
      const stillExists = await prisma.user.findUnique({ where: { id: otherAdminId } });
      expect(stillExists).not.toBeNull();
    } finally {
      countSpy.mockRestore();
    }
  });
});
