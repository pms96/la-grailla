/* Desbloquea la cuenta de un operador (bloqueo por intentos fallidos) desde la consola del servidor.
 * Existe porque el bloqueo se puede provocar a distancia con contraseñas erróneas: quien tenga acceso
 * al servidor debe poder levantarlo sin esperar ni depender de otro superadministrador.
 *
 *   npm run operator:unlock -- --email tu@correo.es
 */
import { prisma } from '../lib/db';
import { unlockOperator } from '../lib/services/auth';

async function main() {
  const i = process.argv.indexOf('--email');
  const email = (i >= 0 ? process.argv[i + 1] : '')?.trim().toLowerCase();
  if (!email) throw new Error('Falta --email');
  const op = await prisma.operator.findUnique({ where: { email } });
  if (!op) throw new Error('No existe ese operador');
  // H-170: levanta el bloqueo de la cuenta y también los cupos por IP.
  await unlockOperator(op.id, { id: null, email: 'cli@servidor' }, { email, via: 'cli' });
  console.log(`Cuenta desbloqueada: ${email}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
