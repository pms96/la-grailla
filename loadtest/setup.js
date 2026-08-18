require('dotenv/config');
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();
const FIXTURES_PATH = path.join(__dirname, '.fixtures.json');

// Cuánto stock tiene el tipo de entrada "escaso" para el test de sobreventa
// (race.js). Bájalo/súbelo si quieres una carrera más o menos reñida.
const SCARCE_STOCK = 200;
const BULK_STOCK = 5_000_000;

async function main() {
  if (fs.existsSync(FIXTURES_PATH)) {
    throw new Error(
      `Ya existe ${FIXTURES_PATH} — parece que quedó un test anterior sin limpiar. ` +
      `Ejecuta "node loadtest/teardown.js" antes de volver a lanzar el setup.`
    );
  }

  const originalGateway = await prisma.appConfig.findUnique({ where: { key: 'payment_gateway' } });
  const originalCommission = await prisma.appConfig.findUnique({ where: { key: 'commission_percentage' } });

  // Pasarela "mock" durante el test de carga: sin esto, cada pedido
  // intentaría crear una sesión real en Stripe/SumUp, lo que mediría la
  // latencia de la pasarela externa (y su propio rate limit) en vez de la
  // capacidad real de nuestra app + base de datos.
  await prisma.appConfig.upsert({
    where: { key: 'payment_gateway' },
    update: { value: 'mock' },
    create: { key: 'payment_gateway', value: 'mock', label: 'Pasarela de pago activa', group: 'payment' },
  });
  await prisma.appConfig.upsert({
    where: { key: 'commission_percentage' },
    update: { value: '0' },
    create: { key: 'commission_percentage', value: '0', label: 'Comisión por entrada (%)', group: 'payment' },
  });

  const suffix = Date.now();

  const scarceEvent = await prisma.event.create({
    data: {
      name: `[LOADTEST] Evento con aforo limitado ${suffix}`,
      slug: `loadtest-escaso-${suffix}`,
      venue: 'Sala de carga', city: 'Testville',
      date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      maxCapacity: SCARCE_STOCK,
      status: 'PUBLISHED',
    },
  });
  const scarceTicketType = await prisma.ticketType.create({
    data: { eventId: scarceEvent.id, name: 'Entrada Limitada', price: 10, maxQuantity: SCARCE_STOCK },
  });

  const bulkEvent = await prisma.event.create({
    data: {
      name: `[LOADTEST] Evento de tráfico general ${suffix}`,
      slug: `loadtest-general-${suffix}`,
      venue: 'Sala de carga', city: 'Testville',
      date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      maxCapacity: BULK_STOCK,
      status: 'PUBLISHED',
    },
  });
  const bulkTicketType = await prisma.ticketType.create({
    data: { eventId: bulkEvent.id, name: 'Entrada General', price: 15, maxQuantity: BULK_STOCK },
  });

  const fixtures = {
    originalGateway: originalGateway?.value ?? null,
    originalCommission: originalCommission?.value ?? null,
    scarce: { eventId: scarceEvent.id, eventSlug: scarceEvent.slug, ticketTypeId: scarceTicketType.id, maxQuantity: SCARCE_STOCK },
    bulk: { eventId: bulkEvent.id, eventSlug: bulkEvent.slug, ticketTypeId: bulkTicketType.id },
  };
  fs.writeFileSync(FIXTURES_PATH, JSON.stringify(fixtures, null, 2));

  console.log('Fixtures de test de carga creadas:');
  console.log(JSON.stringify(fixtures, null, 2));
  console.log(`\nGuardado en ${FIXTURES_PATH}`);
}

main()
  .catch((e) => { console.error('SETUP FAILED', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
