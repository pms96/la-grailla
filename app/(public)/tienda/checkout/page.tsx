import { Container } from '@/components/layouts/container';
import { currentVatRate } from '@/lib/fiscal';
import { termsVersionOrNull } from '@/lib/legal-terms';
import { getCaptchaSiteKey } from '@/lib/captcha';
import ShopCheckoutClient from './_components/shop-checkout-client';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Finalizar compra | Tienda',
  description: 'Completa tus datos de envío para tu pedido.',
};

export default async function TiendaCheckoutPage() {
  const vatRate = await currentVatRate('tienda');
  // Versión de las condiciones con las que se pinta ESTA pantalla (el servidor responde 409 si cambiaron antes de pagar).
  const termsVersion = await termsVersionOrNull('tienda');
  // Sin versión no hay formulario: el servidor no podría comprobar que el comprador vio las condiciones vigentes (H-143).
  if (!termsVersion) {
    return (
      <Container size="lg">
        <div className="py-8">
          <p role="alert" className="text-muted-foreground">No podemos mostrar ahora las condiciones de venta, así que la compra no está disponible. Vuelve a intentarlo en unos minutos.</p>
        </div>
      </Container>
    );
  }
  const captchaSiteKey = await getCaptchaSiteKey();
  return (
    <Container size="lg">
      <div className="py-8">
        <ShopCheckoutClient vatIncluded={(vatRate ?? 0) > 0} termsVersion={termsVersion} captchaSiteKey={captchaSiteKey} />
      </div>
    </Container>
  );
}
