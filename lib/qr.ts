import QRCode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';

export function generateQRCode(): string {
  return `LG-${uuidv4()}`;
}

export async function generateQRDataUrl(qrCode: string): Promise<string> {
  return QRCode.toDataURL(qrCode, {
    width: 300,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
    errorCorrectionLevel: 'H',
  });
}

export async function generateQRSvg(qrCode: string): Promise<string> {
  return QRCode.toString(qrCode, {
    type: 'svg',
    width: 300,
    margin: 2,
    errorCorrectionLevel: 'H',
  });
}
