/* Crea un operador del panel desde la consola del servidor (el primer SUPERADMIN no puede
 * crearse desde el propio panel). Imprime una contraseña temporal UNA vez; en el primer acceso
 * el operador tiene que cambiarla y activar la verificación en dos pasos.
 *
 *   npm run operator:create -- --email tu@correo.es --name "Tu Nombre" --role SUPERADMIN
 */
import { appendAudit } from '../lib/audit';
import { prisma } from '../lib/db';
import { generateTemporaryPassword, hashPassword } from '../lib/password';

const ROLES = ['VIEWER', 'OPERATOR', 'BILLING', 'SUPERADMIN'] as const;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg('email')?.trim().toLowerCase();
  const name = arg('name')?.trim();
  const role = (arg('role') ?? 'SUPERADMIN') as (typeof ROLES)[number];
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Falta --email válido');
  if (!name || name.length < 2) throw new Error('Falta --name');
  if (!ROLES.includes(role)) throw new Error(`--role debe ser uno de ${ROLES.join(', ')}`);
  if (await prisma.operator.findUnique({ where: { email } })) throw new Error('Ya existe un operador con ese email');

  const temporaryPassword = generateTemporaryPassword();
  await prisma.$transaction(async (tx) => {
    const op = await tx.operator.create({ data: { email, name, role, passwordHash: await hashPassword(temporaryPassword), mustChangePassword: true } });
    await appendAudit(tx, { actor: { id: null, email: 'cli@servidor' }, action: 'operator.create', targetType: 'operator', targetId: op.id, meta: { email, role, via: 'cli' } });
  });
  console.log(`Operador creado: ${email} (${role})`);
  console.log(`Contraseña temporal (se muestra solo ahora): ${temporaryPassword}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
