import { describe, expect, it } from 'vitest';
import forge from 'node-forge';
import { PKPass } from 'passkit-generator';
import { APPLE_WWDR_CERT_PEM } from '@/lib/apple-wwdr-cert';

/* H-161: node-forge (lectura del .p12) y passkit-generator (firma del .pkpass) se subieron por avisos de `npm audit` y NINGÚN test firmaba un pase real: una
 * regresión en cualquiera de las dos solo se habría visto con un cliente comprando una entrada. Aquí se hace el mismo recorrido que lib/wallet.ts con un
 * certificado autofirmado de prueba (nunca uno de Apple): empaquetar y leer un .p12, y firmar un pase con él. */

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function selfSignedP12(passphrase: string): string {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600_000);
  const attrs = [{ name: 'commonName', value: 'Pass Type ID de prueba' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], passphrase, { algorithm: '3des' });
  return forge.util.encode64(forge.asn1.toDer(asn1).getBytes());
}

/** Misma lectura que `extractPemFromP12` de lib/wallet.ts. */
function extractPem(p12Base64: string, passphrase: string) {
  const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.decode64(p12Base64)), false, passphrase);
  const cert = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag]?.[0]?.cert;
  const key = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0]?.key;
  return { cert, key };
}

describe('H-161: firma de pases de Apple Wallet con las librerías instaladas', () => {
  it('lee un .p12 y firma un .pkpass válido', async () => {
    const passphrase = 'prueba-h161';
    const p12 = selfSignedP12(passphrase);
    const { cert, key } = extractPem(p12, passphrase);
    expect(cert && key).toBeTruthy();

    const pass = new PKPass(
      {
        'pass.json': Buffer.from(
          JSON.stringify({
            formatVersion: 1,
            passTypeIdentifier: 'pass.test.h161',
            teamIdentifier: 'TEAM123456',
            organizationName: 'Cliente de prueba',
            description: 'Entrada de prueba',
            serialNumber: 'T-H161',
            eventTicket: {},
          })
        ),
        'icon.png': PNG_1X1,
        'icon@2x.png': PNG_1X1,
        'logo.png': PNG_1X1,
      },
      {
        wwdr: Buffer.from(APPLE_WWDR_CERT_PEM),
        signerCert: Buffer.from(forge.pki.certificateToPem(cert!)),
        signerKey: Buffer.from(forge.pki.privateKeyToPem(key!)),
      }
    );
    pass.type = 'eventTicket';
    pass.primaryFields.push({ key: 'event', label: 'Evento', value: 'Evento de prueba' });
    pass.setBarcodes({ message: 'QR-DE-PRUEBA', format: 'PKBarcodeFormatQR', messageEncoding: 'iso-8859-1' });

    const buffer = pass.getAsBuffer();
    // Un .pkpass es un ZIP: empieza por «PK» y lleva la firma (`signature`) y el manifiesto.
    expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK');
    const text = buffer.toString('latin1');
    expect(text).toContain('signature');
    expect(text).toContain('manifest.json');
  }, 60_000);

  it('una contraseña incorrecta del .p12 no devuelve certificado ni clave', () => {
    const p12 = selfSignedP12('la-buena');
    expect(() => extractPem(p12, 'la-mala')).toThrow();
  }, 60_000);
});
