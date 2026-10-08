import bcrypt from 'bcryptjs';
import type { OperatorRole } from '@prisma/client';
import { publicKeyOf } from '@grailla/contracts';
import type { ActingOperator } from '@/lib/actor';
import { prisma } from '@/lib/db';
import { createTenant } from '@/lib/services/tenants';
import { MemoryRegistryStore, setRegistryStoreForTests } from '@/lib/registry/store';

let n = 0;
export const uniq = () => `${Date.now().toString(36)}${(n++).toString(36)}`;

/** Vacía todo salvo el catálogo y la auditoría (que es de solo inserción). */
export async function resetControlDb() {
  await prisma.licenseKey.deleteMany();
  await prisma.domain.deleteMany();
  await prisma.subscriptionModule.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.tenant.deleteMany();
  await prisma.operatorSession.deleteMany();
  await prisma.operator.deleteMany();
}

export async function makeOperator(role: OperatorRole = 'SUPERADMIN', over: Partial<{ email: string; password: string }> = {}) {
  const email = over.email ?? `op-${uniq()}@test.local`;
  const op = await prisma.operator.create({
    data: { email, name: `Op ${role}`, role, passwordHash: await bcrypt.hash(over.password ?? 'clave-de-prueba-123', 4), mustChangePassword: false },
  });
  const actor: ActingOperator = { id: op.id, email: op.email, role, ip: '127.0.0.1', userAgent: 'vitest' };
  return { op, actor };
}

export function freshStore() {
  const store = new MemoryRegistryStore();
  setRegistryStoreForTests(store);
  return store;
}

export const signerPublicKey = () => publicKeyOf(process.env.SNAPSHOT_SIGNING_KEY!);

export const DB_URLS = {
  dbUrlPooled: 'postgresql://cliente:secreto-pooled@ep-demo-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require',
  dbUrlDirect: 'postgresql://cliente:secreto-directo@ep-demo.eu-central-1.aws.neon.tech/neondb?sslmode=require',
};

export function tenantInput(over: Record<string, unknown> = {}) {
  const id = uniq();
  return { name: `Cliente ${id}`, productKey: 'grailla', primaryHost: `cliente-${id}.es`, modules: ['tienda'], ...DB_URLS, ...over };
}

/** Alta de cliente con un SUPERADMIN propio (crear un cliente exige database:write). */
export async function rootCreateTenant(input: ReturnType<typeof tenantInput> | Record<string, unknown> = tenantInput()) {
  const { actor } = await makeOperator('SUPERADMIN');
  return createTenant(input as ReturnType<typeof tenantInput>, actor);
}
