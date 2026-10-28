import { Container } from '@/components/layouts/container';
import { currentVatRate } from '@/lib/fiscal';
import { computeTermsVersion } from '@/lib/legal-terms';
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
  const termsVersion = await computeTermsVersion('tienda').then((t) => t.hash).catch(() => undefined);
  const captchaSiteKey = await getCaptchaSiteKey();
  return (
    <Container size="lg">
      <div className="py-8">
        <ShopCheckoutClient vatIncluded={(vatRate ?? 0) > 0} termsVersion={termsVersion} captchaSiteKey={captchaSiteKey} />
      </div>
    </Container>
  );
}
