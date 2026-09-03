import { getConfigs } from '@/lib/config';
import { APPLE_WWDR_CERT_PEM } from '@/lib/apple-wwdr-cert';

export type WalletAvailability = { google: boolean; apple: boolean };

export async function getWalletAvailability(): Promise<WalletAvailability> {
  try {
    const cfg = await getConfigs([
      'google_wallet_issuer_id',
      'google_wallet_service_account',
      'apple_wallet_enabled',
      'apple_wallet_pass_type_id',
      'apple_wallet_team_id',
      'apple_wallet_cert_p12_base64',
    ]);
    return {
      google: Boolean(cfg.google_wallet_issuer_id && cfg.google_wallet_service_account),
      apple: Boolean(
        cfg.apple_wallet_enabled === 'true' &&
          cfg.apple_wallet_pass_type_id &&
          cfg.apple_wallet_team_id &&
          cfg.apple_wallet_cert_p12_base64
      ),
    };
  } catch {
    return { google: false, apple: false };
  }
}

type TicketPayload = {
  ticketId: string;
  eventId: string;
  qrCode: string;
  holderName: string;
  eventName: string;
  venue: string;
  city: string;
  date: Date;
  ticketTypeName: string;
  eventImageUrl?: string | null;
};

export async function buildGoogleWalletSaveUrl(ticket: TicketPayload): Promise<string | null> {
  const cfg = await getConfigs(['google_wallet_issuer_id', 'google_wallet_service_account']);
  const issuerId = cfg.google_wallet_issuer_id;
  if (!issuerId || !cfg.google_wallet_service_account) return null;

  let credentials: { client_email?: string; private_key?: string } | undefined;
  try {
    credentials = JSON.parse(cfg.google_wallet_service_account);
  } catch {
    console.error('Google Wallet: service account JSON invalido');
    return null;
  }
  if (!credentials?.client_email || !credentials?.private_key) return null;

  // Una clase por evento, no una única compartida por todo el emisor: los
  // campos eventName/venue/dateTime viven en la CLASE, no en el objeto —
  // con una sola clase para todos los eventos, guardar una entrada de un
  // evento pisaba esos datos para cualquiera que ya se hubiera guardado la
  // entrada de OTRO evento (visto en producción: dos eventos a la vez, las
  // dos tarjetas de Wallet acababan mostrando el nombre del último guardado).
  const classId = issuerId + '.event_' + ticket.eventId.replace(/[^A-Za-z0-9_.-]/g, '');
  const objectId = issuerId + '.tk_' + ticket.ticketId.replace(/[^A-Za-z0-9_.-]/g, '');

  const appUrl = process.env.NEXTAUTH_URL ?? '';
  // Wallet no admite CSS a medida (dos tonos, avatar circular, etc.) — esto es
  // la mejor aproximación con los campos nativos que expone Google: la foto
  // del cartel como heroImage (banner ancho, no circular) y hexBackgroundColor
  // en el oscuro de la cabecera del diseño (#1F1A22), ya que la tarjeta solo
  // admite un color de fondo, no dos zonas distintas.
  const eventTicketClass: Record<string, unknown> = {
    id: classId,
    issuerName: 'La Grailla',
    reviewStatus: 'UNDER_REVIEW',
    hexBackgroundColor: '#1F1A22',
    logo: {
      sourceUri: { uri: appUrl + '/brand/logo-white.png' },
      contentDescription: { defaultValue: { language: 'es-ES', value: 'La Grailla' } },
    },
    eventName: { defaultValue: { language: 'es-ES', value: ticket.eventName } },
    venue: {
      name: { defaultValue: { language: 'es-ES', value: ticket.venue } },
      address: { defaultValue: { language: 'es-ES', value: ticket.city } },
    },
    dateTime: { start: new Date(ticket.date).toISOString() },
  };
  if (ticket.eventImageUrl) {
    eventTicketClass.heroImage = {
      sourceUri: { uri: ticket.eventImageUrl },
      contentDescription: { defaultValue: { language: 'es-ES', value: ticket.eventName } },
    };
  }

  const eventTicketObject = {
    id: objectId,
    classId,
    state: 'ACTIVE',
    ticketHolderName: ticket.holderName,
    ticketType: { defaultValue: { language: 'es-ES', value: ticket.ticketTypeName } },
    barcode: { type: 'QR_CODE', value: ticket.qrCode, alternateText: ticket.qrCode },
    hexBackgroundColor: '#a855f7',
  };

  const jwtLib = (await import('jsonwebtoken')) as typeof import('jsonwebtoken') & {
    default?: typeof import('jsonwebtoken');
  };
  const sign = jwtLib.default?.sign ?? jwtLib.sign;

  const claims = {
    iss: credentials.client_email,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(Date.now() / 1000),
    payload: { eventTicketClasses: [eventTicketClass], eventTicketObjects: [eventTicketObject] },
  };

  const token = sign(claims, credentials.private_key, { algorithm: 'RS256' });
  return 'https://pay.google.com/gp/v/save/' + token;
}

// El pase de Apple Wallet necesita el logo como binario embebido (no como
// URL) — se descarga del propio dominio en vez de leerlo del filesystem
// para no depender de que Next.js incluya `public/` en el bundle de la
// función serverless (mismo motivo que llevó a embeber el certificado WWDR
// como constante en vez de leerlo de disco).
async function fetchLogoBuffer(): Promise<Buffer> {
  const appUrl = process.env.NEXTAUTH_URL ?? '';
  const res = await fetch(appUrl + '/brand/logo-white.png');
  return Buffer.from(await res.arrayBuffer());
}

// Banda decorativa estática de marca (glow morado/lima sobre azul marino
// profundo, mismo lenguaje que .hero-gradient en la web pública) — rellena
// el hueco que el pase deja vacío entre los campos y el código de barras
// cuando no hay imagen "strip". Se usa la misma para todas las entradas: la
// foto real del evento (retrato, pensada para un cartel) recortaría fatal
// en un formato tan ancho, así que de momento no varía por evento.
async function fetchStripBuffer(): Promise<Buffer> {
  const appUrl = process.env.NEXTAUTH_URL ?? '';
  const res = await fetch(appUrl + '/brand/wallet-strip.png');
  return Buffer.from(await res.arrayBuffer());
}

// passkit-generator firma el .pkpass con node-forge y espera el certificado
// y la clave privada como texto PEM por separado — nunca acepta un .p12
// (PKCS#12) directamente. El admin solo puede exportar un .p12 desde
// Acceso a Llaveros/Keychain (es el único formato que Apple entrega), así
// que hay que desempaquetarlo aquí antes de pasárselo a la librería.
async function extractPemFromP12(
  p12Base64: string,
  passphrase: string | undefined
): Promise<{ certPem: string; keyPem: string }> {
  const forgeModule = await import('node-forge');
  const forge = (forgeModule as unknown as { default?: typeof forgeModule }).default ?? forgeModule;

  const p12Der = forge.util.decode64(p12Base64);
  const p12Asn1 = forge.asn1.fromDer(p12Der);
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, passphrase ?? '');

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const cert = certBags[forge.pki.oids.certBag]?.[0]?.cert;
  const key = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0]?.key;
  if (!cert || !key) {
    throw new Error('El .p12 no contiene un certificado y una clave privada válidos (¿contraseña incorrecta?)');
  }

  return { certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(key) };
}

export async function buildApplePass(ticket: TicketPayload): Promise<Buffer | null> {
  const cfg = await getConfigs([
    'apple_wallet_enabled',
    'apple_wallet_pass_type_id',
    'apple_wallet_team_id',
    'apple_wallet_cert_p12_base64',
    'apple_wallet_cert_password',
  ]);
  if (cfg.apple_wallet_enabled !== 'true') return null;
  if (!cfg.apple_wallet_pass_type_id || !cfg.apple_wallet_team_id || !cfg.apple_wallet_cert_p12_base64) return null;

  try {
    const { PKPass } = await import('passkit-generator');
    const { certPem, keyPem } = await extractPemFromP12(cfg.apple_wallet_cert_p12_base64, cfg.apple_wallet_cert_password);
    const iconBuffer = await fetchLogoBuffer();
    const stripBuffer = await fetchStripBuffer();

    const passJson = {
      formatVersion: 1,
      passTypeIdentifier: cfg.apple_wallet_pass_type_id,
      teamIdentifier: cfg.apple_wallet_team_id,
      organizationName: 'La Grailla',
      description: 'Entrada ' + ticket.eventName,
      serialNumber: ticket.ticketId,
      // Azul Marino Profundo + Verde Lima como labelColor: la misma pareja de
      // marca morado/lima que el resto del producto, en vez de los tonos
      // genéricos anteriores que no remitían a La Grailla.
      foregroundColor: 'rgb(255,255,255)',
      backgroundColor: 'rgb(11,11,20)',
      labelColor: 'rgb(197,230,58)',
      eventTicket: {},
    };

    const pass = new PKPass(
      {
        'pass.json': Buffer.from(JSON.stringify(passJson)),
        'icon.png': iconBuffer,
        'icon@2x.png': iconBuffer,
        'logo.png': iconBuffer,
        'strip.png': stripBuffer,
        'strip@2x.png': stripBuffer,
      },
      {
        wwdr: Buffer.from(APPLE_WWDR_CERT_PEM),
        signerCert: Buffer.from(certPem),
        signerKey: Buffer.from(keyPem),
      }
    );

    pass.type = 'eventTicket';
    pass.primaryFields.push({ key: 'event', label: 'Evento', value: ticket.eventName });
    pass.secondaryFields.push({ key: 'holder', label: 'Titular', value: ticket.holderName });
    pass.secondaryFields.push({
      key: 'date',
      label: 'Fecha',
      value: new Date(ticket.date).toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' }),
    });
    pass.auxiliaryFields.push({ key: 'venue', label: 'Lugar', value: ticket.venue + ' - ' + ticket.city });
    pass.auxiliaryFields.push({ key: 'ticketType', label: 'Tipo', value: ticket.ticketTypeName });
    pass.setBarcodes({ message: ticket.qrCode, format: 'PKBarcodeFormatQR', messageEncoding: 'iso-8859-1' });

    return pass.getAsBuffer();
  } catch (error) {
    console.error('Apple Wallet error:', error instanceof Error ? error.message : error);
    return null;
  }
}
