import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  // Admin account for La Grailla. Credenciales por variables de entorno,
  // nunca hardcodeadas: reejecutar el seed con un ADMIN_PASSWORD nuevo rota la contraseña.
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) {
    throw new Error('ADMIN_EMAIL y ADMIN_PASSWORD son obligatorias para ejecutar el seed. Defínelas en .env.');
  }
  const hashedAdminPassword = await bcrypt.hash(adminPassword, 12);
  await prisma.user.upsert({
    where: { email: adminEmail },
    update: { hashedPassword: hashedAdminPassword },
    create: {
      email: adminEmail,
      name: 'Admin La Grailla',
      hashedPassword: hashedAdminPassword,
      role: 'ADMIN',
    },
  });

  // Cuenta de admin secundaria opcional, solo si se configura explícitamente.
  if (process.env.TEST_ADMIN_EMAIL && process.env.TEST_ADMIN_PASSWORD) {
    const hashedTestPassword = await bcrypt.hash(process.env.TEST_ADMIN_PASSWORD, 12);
    await prisma.user.upsert({
      where: { email: process.env.TEST_ADMIN_EMAIL },
      update: { hashedPassword: hashedTestPassword },
      create: {
        email: process.env.TEST_ADMIN_EMAIL,
        name: 'Admin Test',
        hashedPassword: hashedTestPassword,
        role: 'ADMIN',
      },
    });
  }

  // Default app configuration
  const configs = [
    { key: 'payment_gateway', value: 'mock', label: 'Pasarela de pago activa', group: 'payment' },
    { key: 'stripe_publishable_key', value: '', label: 'Stripe Publishable Key', group: 'payment' },
    { key: 'stripe_secret_key', value: '', label: 'Stripe Secret Key', group: 'payment' },
    { key: 'sumup_api_key', value: '', label: 'SumUp API Key', group: 'payment' },
    { key: 'commission_percentage', value: '0', label: 'Comisi\u00f3n por entrada (%)', group: 'payment' },
    { key: 'legal_notice', value: 'Aviso legal de La Grailla. Configurable desde el panel de administraci\u00f3n.', label: 'Aviso Legal', group: 'legal' },
    { key: 'privacy_policy', value: 'Pol\u00edtica de privacidad de La Grailla. Configurable desde el panel de administraci\u00f3n.', label: 'Pol\u00edtica de Privacidad', group: 'legal' },
    { key: 'cookies_policy', value: 'Pol\u00edtica de cookies de La Grailla. Configurable desde el panel de administraci\u00f3n.', label: 'Pol\u00edtica de Cookies', group: 'legal' },
    { key: 'social_instagram', value: '', label: 'Instagram', group: 'social' },
    { key: 'social_tiktok', value: '', label: 'TikTok', group: 'social' },
    { key: 'social_twitter', value: '', label: 'Twitter/X', group: 'social' },
    { key: 'social_facebook', value: '', label: 'Facebook', group: 'social' },
    { key: 'admin_email', value: adminEmail, label: 'Email de administraci\u00f3n', group: 'general' },
    { key: 'cookies_banner_enabled', value: 'true', label: 'Banner de cookies activo', group: 'general' },
    { key: 'smtp_enabled', value: 'false', label: 'Usar SMTP propio', group: 'email' },
    { key: 'smtp_host', value: '', label: 'Servidor SMTP', group: 'email' },
    { key: 'smtp_port', value: '587', label: 'Puerto SMTP', group: 'email' },
    { key: 'smtp_user', value: '', label: 'Usuario SMTP', group: 'email' },
    { key: 'smtp_password', value: '', label: 'Contraseña SMTP', group: 'email' },
    { key: 'smtp_secure', value: 'false', label: 'Conexión segura (SSL/TLS)', group: 'email' },
    { key: 'smtp_from_email', value: '', label: 'Email remitente', group: 'email' },
    { key: 'smtp_from_name', value: 'La Grailla', label: 'Nombre remitente', group: 'email' },
    { key: 'google_wallet_issuer_id', value: '', label: 'Google Wallet Issuer ID', group: 'wallet' },
    { key: 'google_wallet_service_account', value: '', label: 'Google Wallet Service Account (JSON)', group: 'wallet' },
    { key: 'apple_wallet_enabled', value: 'false', label: 'Apple Wallet activo', group: 'wallet' },
    { key: 'apple_wallet_pass_type_id', value: '', label: 'Apple Pass Type ID', group: 'wallet' },
    { key: 'apple_wallet_team_id', value: '', label: 'Apple Team ID', group: 'wallet' },
    { key: 'apple_wallet_cert_p12_base64', value: '', label: 'Certificado .p12 (base64)', group: 'wallet' },
    { key: 'apple_wallet_cert_password', value: '', label: 'Contraseña del certificado', group: 'wallet' },
  ];

  for (const c of configs) {
    await prisma.appConfig.upsert({
      where: { key: c.key },
      update: {},
      create: c,
    });
  }

  // Sample event
  const event = await prisma.event.upsert({
    where: { slug: 'noche-inaugural-2025' },
    update: {},
    create: {
      name: 'Noche Inaugural 2025',
      slug: 'noche-inaugural-2025',
      description: 'La Grailla inaugura la temporada 2025 con una noche inolvidable. M\u00fasica, ambiente y la mejor experiencia.',
      venue: 'Sala La Grailla',
      city: 'Logro\u00f1o',
      address: 'Calle Ejemplo 42, 26001 Logro\u00f1o, La Rioja',
      artists: 'DJ Alpha, DJ Beta, MC Gamma',
      date: new Date('2025-09-20T23:00:00'),
      doorsOpen: '23:00',
      endTime: '06:00',
      minAge: 18,
      conditions: 'Prohibido el acceso con bebidas del exterior. DNI obligatorio. Dress code: casual.',
      maxCapacity: 500,
      status: 'PUBLISHED',
    },
  });

  // Sample ticket types
  await prisma.ticketType.upsert({
    where: { id: 'tt-early-bird' },
    update: {},
    create: {
      id: 'tt-early-bird',
      eventId: event.id,
      name: 'Early Bird',
      description: 'Entrada anticipada a precio reducido',
      price: 12,
      phase: 1,
      phaseName: 'Early Bird',
      maxQuantity: 100,
      soldCount: 0,
      isActive: true,
      sortOrder: 1,
    },
  });

  await prisma.ticketType.upsert({
    where: { id: 'tt-general' },
    update: {},
    create: {
      id: 'tt-general',
      eventId: event.id,
      name: 'Entrada General',
      description: 'Acceso general al evento',
      price: 18,
      phase: 2,
      phaseName: 'Venta General',
      maxQuantity: 300,
      soldCount: 0,
      isActive: true,
      sortOrder: 2,
    },
  });

  await prisma.ticketType.upsert({
    where: { id: 'tt-vip' },
    update: {},
    create: {
      id: 'tt-vip',
      eventId: event.id,
      name: 'VIP',
      description: 'Acceso VIP con zona reservada',
      price: 30,
      phase: 1,
      phaseName: 'Todas las fases',
      maxQuantity: 50,
      soldCount: 0,
      isActive: true,
      sortOrder: 3,
    },
  });

  // Sample product
  await prisma.product.upsert({
    where: { slug: 'camiseta-la-grailla' },
    update: {},
    create: {
      name: 'Camiseta La Grailla',
      slug: 'camiseta-la-grailla',
      description: 'Camiseta oficial La Grailla. 100% algod\u00f3n org\u00e1nico.',
      price: 25,
      category: 'Ropa',
      isActive: true,
    },
  });

  console.log('Seed completado correctamente');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
