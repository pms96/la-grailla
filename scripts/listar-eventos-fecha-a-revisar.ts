/* Lista (SOLO LECTURA) los eventos cuya fecha puede estar desfasada por el error de zona horaria anterior a P0-02 (H-073). No modifica nada.
 *
 *   npx tsx scripts/listar-eventos-fecha-a-revisar.ts --antes-de=2026-10-15
 *
 * `--antes-de` es la fecha (YYYY-MM-DD) en que se desplegó el arreglo de la zona horaria en ESE cliente: los eventos creados después ya guardan la hora de Madrid.
 * Usa `DATABASE_URL` del entorno (la BD del cliente). Para cada candidato imprime la fecha tal como la ve hoy el público, la que probablemente se quiso y cuántos
 * compradores tiene. Corregirla es una decisión del dueño, a mano, desde el panel (Eventos → editar): ver «Acciones del dueño» en docs/platform/revision-integral.md. */
import { PrismaClient } from '@prisma/client';
import { eventsNeedingDateReview } from '../lib/event-date-review';

async function main() {
  const arg = process.argv.find((a) => a.startsWith('--antes-de='))?.slice('--antes-de='.length);
  const createdBefore = arg && /^\d{4}-\d{2}-\d{2}$/.test(arg) ? new Date(`${arg}T00:00:00Z`) : null;
  if (!createdBefore || Number.isNaN(createdBefore.getTime())) {
    console.error('Falta --antes-de=YYYY-MM-DD (la fecha en que se desplegó el arreglo de la zona horaria).');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.event.findMany({
      where: { createdAt: { lt: createdBefore }, status: { notIn: ['CANCELLED', 'FINISHED'] }, date: { gt: new Date() } },
      select: { id: true, name: true, slug: true, date: true, status: true, createdAt: true, _count: { select: { orders: { where: { status: 'COMPLETED' } } } } },
    });
    const list = eventsNeedingDateReview(
      rows.map(({ _count, ...e }) => ({ ...e, completedOrders: _count.orders })),
      { createdBefore, now: new Date() }
    );
    if (list.length === 0) {
      console.log('Ningún evento candidato: no hay eventos por celebrarse creados antes de esa fecha.');
      return;
    }
    console.log(`${list.length} evento(s) por revisar (creados antes del ${arg}, aún por celebrarse):\n`);
    for (const r of list) {
      console.log(`• ${r.name} [${r.status}] /eventos/${r.slug}`);
      console.log(`    Se ve ahora (Madrid): ${r.savedLocal.replace('T', ' ')}   Probablemente se quiso: ${r.intendedLocal.replace('T', ' ')}`);
      console.log(`    ${r.advice}\n`);
    }
    console.log('Esto es solo un aviso: no se ha cambiado nada. Si la hora que se ve ahora es la correcta, no hace falta hacer nada.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
