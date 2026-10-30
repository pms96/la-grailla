'use client';

import { useState } from 'react';
import { Loader2, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ConfigField } from '@/app/admin/_components/config-field';

type Props = {
  /** '' = cuenta de Entradas (`stripe_secret_key`…); 'shop_' = cuenta de la Tienda (`shop_stripe_secret_key`…). */
  prefix: '' | 'shop_';
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  /** Ruta del webhook de Stripe de ESTA cuenta (cada módulo tiene la suya). */
  webhookPath: string;
  /** Texto bajo el selector cuando todavía no se ha elegido pasarela (la Tienda hereda la cuenta de Entradas hasta entonces). */
  unsetHint?: string;
};

/** Una cuenta de cobro: pasarela activa, Stripe y SumUp. Entradas y Tienda tienen cada una la suya (no comparten claves). */
export function PaymentAccount({ prefix, values, onChange, webhookPath, unsetHint }: Props) {
  const k = (name: string) => `${prefix}${name}`;
  const [testing, setTesting] = useState<'stripe' | 'sumup' | null>(null);
  const gateway = values[k('payment_gateway')] ?? (prefix === '' ? 'mock' : '');

  const test = async (which: 'stripe' | 'sumup') => {
    setTesting(which);
    try {
      // `scope`: la cuenta de ESTA pestaña. Sin él, un campo enmascarado se probaría contra la cuenta de Entradas.
      const scope = prefix === 'shop_' ? 'tienda' : 'entradas';
      const body =
        which === 'stripe'
          ? { gateway: which, scope, secretKey: values[k('stripe_secret_key')] ?? '' }
          : { gateway: which, scope, apiKey: values[k('sumup_api_key')] ?? '', merchantCode: values[k('sumup_merchant_code')] ?? '' };
      const res = await fetch('/api/admin/config/test-gateway', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (data?.ok) toast.success(which === 'stripe' ? 'Conexión con Stripe correcta' : 'Conexión con SumUp correcta');
      else toast.error(data?.error ?? 'No se ha podido conectar');
    } catch {
      toast.error('Error de conexión');
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <Label>Pasarela de pago activa</Label>
        <Select value={gateway || undefined} onValueChange={(v: string) => onChange(k('payment_gateway'), v)}>
          <SelectTrigger className="mt-1">
            <SelectValue placeholder={unsetHint ? 'Sin elegir (cuenta de Entradas)' : undefined} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="mock">Desactivada (modo prueba)</SelectItem>
            <SelectItem value="stripe">Stripe</SelectItem>
            <SelectItem value="sumup">SumUp</SelectItem>
          </SelectContent>
        </Select>
        {!gateway && unsetHint && <p className="text-xs text-muted-foreground mt-1">{unsetHint}</p>}
      </div>

      <div className="rounded-lg border border-border p-4 space-y-4">
        <h4 className="font-semibold text-sm">Stripe</h4>
        <ConfigField label="Publishable Key" value={values[k('stripe_publishable_key')] ?? ''} onChange={(v) => onChange(k('stripe_publishable_key'), v)} placeholder="pk_..." />
        <ConfigField label="Secret Key" type="password" value={values[k('stripe_secret_key')] ?? ''} onChange={(v) => onChange(k('stripe_secret_key'), v)} placeholder="sk_..." />
        <ConfigField
          label="Webhook Secret"
          type="password"
          value={values[k('stripe_webhook_secret')] ?? ''}
          onChange={(v) => onChange(k('stripe_webhook_secret'), v)}
          placeholder="whsec_..."
          description={`En Stripe Dashboard → Developers → Webhooks, crea un endpoint apuntando a ${webhookPath} escuchando checkout.session.completed, checkout.session.async_payment_succeeded, checkout.session.async_payment_failed y checkout.session.expired. Copia aquí el 'Signing secret' que te da Stripe al crearlo.`}
        />
        <Button type="button" variant="outline" size="sm" className="gap-2" disabled={testing === 'stripe'} onClick={() => test('stripe')}>
          {testing === 'stripe' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
          Probar conexión con Stripe
        </Button>
      </div>

      <div className="rounded-lg border border-border p-4 space-y-4">
        <h4 className="font-semibold text-sm">SumUp</h4>
        <ConfigField label="API Key" type="password" value={values[k('sumup_api_key')] ?? ''} onChange={(v) => onChange(k('sumup_api_key'), v)} />
        <ConfigField
          label="Merchant Code"
          value={values[k('sumup_merchant_code')] ?? ''}
          onChange={(v) => onChange(k('sumup_merchant_code'), v)}
          placeholder="MC..."
          description="Lo encuentras en tu cuenta de SumUp, en Ajustes → Datos de la cuenta. Es obligatorio para crear cobros, la API key sola no basta."
        />
        <Button type="button" variant="outline" size="sm" className="gap-2" disabled={testing === 'sumup'} onClick={() => test('sumup')}>
          {testing === 'sumup' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
          Probar conexión con SumUp
        </Button>
      </div>
    </div>
  );
}
