export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { StripeAdapter, SumUpAdapter } from '@/lib/payment-adapter';
import { handleApiError } from '@/lib/api-error';
import { getConfigOrThrow } from '@/lib/config';
import { SECRET_MASK } from '@/lib/secrets';

// Comprueba la credencial tal como está escrita AHORA MISMO en el formulario
// de /admin/configuracion, antes de guardarla — un espacio invisible pegado
// del dashboard de la pasarela, o una clave caducada, se detectan aquí en
// vez de con el primer comprador real fallando en el checkout.
// `scope` dice DE QUÉ cuenta es el formulario: la pestaña Tienda tiene sus propias claves (`shop_*`), y si el campo llega enmascarado hay que
// probar la guardada DE ESA cuenta (antes se probaba siempre la de Entradas y daba un «correcto» falso, P1-11 / TI-10). Sin `scope`, Entradas.
const scopeField = z.enum(['entradas', 'tienda']).default('entradas');
const testGatewaySchema = z.discriminatedUnion('gateway', [
  z.object({ gateway: z.literal('stripe'), secretKey: z.string(), scope: scopeField }),
  z.object({ gateway: z.literal('sumup'), apiKey: z.string(), merchantCode: z.string(), scope: scopeField }),
]);

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    // H-068 / H-173: con la máscara se prueba la clave GUARDADA, así que probarla equivale a «preguntar» por ella; y las credenciales de cobro son SOLO del
    // propietario (`OWNER_ONLY_CONFIG_KEYS`, H-058: un rol restringido ni las ve ni las guarda). El middleware deja pasar `/api/admin/config/*` a todo
    // administrador, así que el límite se pone aquí: un rol con lista de módulos, aunque incluya el de la cuenta, no usa el probador.
    if (session.user.modules != null) {
      return NextResponse.json({ error: 'Solo el propietario puede probar las credenciales de cobro' }, { status: 403 });
    }

    const body = testGatewaySchema.parse(await request.json());
    if (body.gateway === 'stripe') {
      // El formulario nunca recibe la clave real (ver GET /api/admin/config): si no la
      // ha retocado llega la máscara, y se prueba la que hay guardada.
      const prefix = body.scope === 'tienda' ? 'shop_' : '';
      const secretKey = (body.secretKey === SECRET_MASK ? await getConfigOrThrow(`${prefix}stripe_secret_key`) : body.secretKey).trim();
      if (!secretKey) return NextResponse.json({ ok: false, error: 'Falta la Secret Key' });
      const result = await new StripeAdapter(secretKey).testConnection();
      return NextResponse.json(result);
    }

    const prefix = body.scope === 'tienda' ? 'shop_' : '';
    const apiKey = (body.apiKey === SECRET_MASK ? await getConfigOrThrow(`${prefix}sumup_api_key`) : body.apiKey).trim();
    const merchantCode = body.merchantCode.trim();
    if (!apiKey || !merchantCode) return NextResponse.json({ ok: false, error: 'Falta la API Key o el Merchant Code' });
    const result = await new SumUpAdapter(apiKey, merchantCode).testConnection();
    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/config/test-gateway');
  }
}
