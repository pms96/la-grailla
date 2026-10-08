/* Secreto "de instalación" por cliente, derivado de un maestro del servidor.
 *
 * Hoy el front usa UN NEXTAUTH_SECRET para todo (sesiones, tokens de acceso, claves de config). Con varios
 * clientes en el mismo despliegue eso significaría que la cookie de un admin del cliente A abriría el panel
 * del cliente B. Aquí cada cliente tiene el suyo:
 *
 *   HKDF-SHA256( ikm = maestro, salt = "{tenantId}:{epoch}", info = "grailla-installation-secret:{purpose}" ) → 32 bytes
 *
 * - `purpose` separa usos (sesión, tokens de acceso...): comprometer uno no da el otro.
 * - `epoch` (del RoutingRecord) permite invalidar de golpe sesiones y tokens de UN solo cliente.
 * - El middleware (edge, WebCrypto) y el runtime Node (hkdfSync) tienen que dar EXACTAMENTE el mismo valor:
 *   hay un test que lo comprueba. */
import { toBase64Url } from './snapshot';

const enc = new TextEncoder();

export type InstallationPurpose = 'session' | 'access';

export const installationSalt = (tenantId: string, epoch: number) => `${tenantId}:${epoch}`;
export const installationInfo = (purpose: InstallationPurpose) => `grailla-installation-secret:${purpose}`;

export async function deriveInstallationSecret(master: Uint8Array, tenantId: string, epoch: number, purpose: InstallationPurpose): Promise<string> {
  const base = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(installationSalt(tenantId, epoch)), info: enc.encode(installationInfo(purpose)) },
    base,
    256
  );
  return toBase64Url(new Uint8Array(bits));
}
