require('dotenv/config');
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();
const FIXTURES_PATH = path.join(__dirname, '.fixtures.json');

async function cleanupEvent(eventId) {
  await prisma.ticket.deleteMany({ where: { eventId } });
  await prisma.order.deleteMany({ where: { eventId } });
  await prisma.event.delete({ where: { id: eventId } }).catch(() => {});
}

async function main() {
  if (!fs.existsSync(FIXTURES_PATH)) {
    console.log('No hay fixtures de test de carga que limpiar (¿ya se ejecutó teardown?).');
    return;
  }
  const fixtures = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf-8'));

  console.log('\n=== Verificación de corrección (esto es lo que realmente importa) ===\n');

  const scarceTicketType = await prisma.ticketType.findUnique({ where: { id: fixtures.scarce.ticketTypeId } });
  const scarceValidTickets = await prisma.ticket.count({ where: { ticketTypeId: fixtures.scarce.ticketTypeId, status: 'VALID' } });

  let ok = true;

  if (!scarceTicketType) {
    console.log('⚠️  No se encontró el ticketType "escaso" — ¿se corrió setup.js?');
    ok = false;
  } else {
    const oversold = scarceTicketType.soldCount > scarceTicketType.maxQuantity;
    const consistent = scarceTicketType.soldCount === scarceValidTickets;
    console.log(`Stock máximo:              ${scarceTicketType.maxQuantity}`);
    console.log(`soldCount final:           ${scarceTicketType.soldCount}`);
    console.log(`Entradas VALID en BD:      ${scarceValidTickets}`);
    console.log(oversold ? '❌ SOBREVENTA DETECTADA — soldCount > maxQuantity' : '✅ Sin sobreventa (soldCount <= maxQuantity)');
    console.log(consistent ? '✅ soldCount coincide con las entradas realmente emitidas' : '❌ soldCount NO coincide con las entradas emitidas (inconsistencia)');
    ok = ok && !oversold && consistent;
  }

  const bulkTicketType = await prisma.ticketType.findUnique({ where: { id: fixtures.bulk.ticketTypeId } });
  if (bulkTicketType) {
    const bulkValidTickets = await prisma.ticket.count({ where: { ticketTypeId: fixtures.bulk.ticketTypeId, status: 'VALID' } });
    console.log(`\n[Evento de tráfico general] soldCount: ${bulkTicketType.soldCount}, entradas VALID: ${bulkValidTickets}`);
    if (bulkTicketType.soldCount !== bulkValidTickets) {
      console.log('❌ Inconsistencia también en el evento de tráfico general');
      ok = false;
    }
  }

  console.log('\n=== Limpieza ===\n');
  await cleanupEvent(fixtures.scarce.eventId);
  await cleanupEvent(fixtures.bulk.eventId);

  if (fixtures.originalGateway === null) {
    await prisma.appConfig.delete({ where: { key: 'payment_gateway' } }).catch(() => {});
  } else {
    await prisma.appConfig.update({ where: { key: 'payment_gateway' }, data: { value: fixtures.originalGateway } });
  }
  if (fixtures.originalCommission === null) {
    await prisma.appConfig.delete({ where: { key: 'commission_percentage' } }).catch(() => {});
  } else {
    await prisma.appConfig.update({ where: { key: 'commission_percentage' }, data: { value: fixtures.originalCommission } });
  }

  fs.unlinkSync(FIXTURES_PATH);
  console.log('Eventos, pedidos y configuración de test eliminados/restaurados.');

  console.log(ok ? '\n✅ RESULTADO: sin sobreventa ni inconsistencias.' : '\n❌ RESULTADO: se detectaron problemas — revisa el log de arriba.');
  process.exit(ok ? 0 : 1);
}

main()
  .catch((e) => { console.error('TEARDOWN FAILED', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
