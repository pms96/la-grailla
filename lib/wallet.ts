import { getConfigs } from '@/lib/config';

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
  qrCode: string;
  holderName: string;
  eventName: string;
  venue: string;
  city: string;
  date: Date;
  ticketTypeName: string;
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

  const classId = issuerId + '.lagrailla_event';
  const objectId = issuerId + '.tk_' + ticket.ticketId.replace(/[^A-Za-z0-9_.-]/g, '');

  const eventTicketClass = {
    id: classId,
    issuerName: 'La Grailla',
    reviewStatus: 'UNDER_REVIEW',
    eventName: { defaultValue: { language: 'es-ES', value: ticket.eventName } },
    venue: {
      name: { defaultValue: { language: 'es-ES', value: ticket.venue } },
      address: { defaultValue: { language: 'es-ES', value: ticket.city } },
    },
    dateTime: { start: new Date(ticket.date).toISOString() },
  };

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

const ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAPElEQVR42mP8z8BQz0AEYBxVSFmFjIyM/xkYGP4zMDAwMDIyMjAwMDAwMDAwMDAwMDAwMDAwMAAAiwgH/eLXKZQAAAAASUVORK5CYII=';

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
    const iconBuffer = Buffer.from(ICON_PNG_BASE64, 'base64');

    const passJson = {
      formatVersion: 1,
      passTypeIdentifier: cfg.apple_wallet_pass_type_id,
      teamIdentifier: cfg.apple_wallet_team_id,
      organizationName: 'La Grailla',
      description: 'Entrada ' + ticket.eventName,
      serialNumber: ticket.ticketId,
      foregroundColor: 'rgb(255,255,255)',
      backgroundColor: 'rgb(168,85,247)',
      labelColor: 'rgb(255,255,255)',
      eventTicket: {},
    };

    const pass = new PKPass(
      {
        'pass.json': Buffer.from(JSON.stringify(passJson)),
        'icon.png': iconBuffer,
        'icon@2x.png': iconBuffer,
        'logo.png': iconBuffer,
      },
      {
        wwdr: Buffer.from(cfg.apple_wallet_cert_p12_base64, 'base64'),
        signerCert: Buffer.from(cfg.apple_wallet_cert_p12_base64, 'base64'),
        signerKey: Buffer.from(cfg.apple_wallet_cert_p12_base64, 'base64'),
        signerKeyPassphrase: cfg.apple_wallet_cert_password || undefined,
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
    pass.setBarcodes({ message: ticket.qrCode, format: 'PKBarcodeFormatQR', messageEncoding: 'iso-8859-1' });

    return pass.getAsBuffer();
  } catch (error) {
    console.error('Apple Wallet error:', error instanceof Error ? error.message : error);
    return null;
  }
}
