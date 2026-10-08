import { SecretError, openSecret, sealSecret, sealedKid } from '@grailla/contracts';
import { secretsKeyring } from './env';

/** Sella con la clave activa. `scope` es el tenantId (o `operator:<id>`): entra en la derivación y en el AAD. */
export async function sealField(plain: string, ctx: { scope: string; field: string }): Promise<string> {
  const { activeKid, masters } = secretsKeyring();
  return sealSecret(plain, { kid: activeKid, tenantId: ctx.scope, field: ctx.field }, masters[activeKid]);
}

/** Abre con la clave con la que se selló (permite rotar sin romper lo antiguo). */
export async function openField(stored: string, ctx: { scope: string; field: string }): Promise<string> {
  const { masters } = secretsKeyring();
  const master = masters[sealedKid(stored)];
  if (!master) throw new SecretError('no hay clave maestra para el kid con el que se selló este valor');
  return openSecret(stored, { tenantId: ctx.scope, field: ctx.field }, master);
}
