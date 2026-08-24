'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FadeIn } from '@/components/ui/animate';
import { ArrowLeft, CreditCard, Loader2, Lock, ShoppingBag } from 'lucide-react';
import { type CartLine, cartTotals, readCart, writeCart } from '@/lib/shop-cart';

type FieldErrors = Partial<
  Record<'buyerName' | 'buyerEmail' | 'shippingAddress' | 'shippingCity' | 'shippingZip', string>
>;

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export default function ShopCheckoutClient() {
  const router = useRouter();
  const [cart, setCart] = useState<CartLine[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [form, setForm] = useState({
    buyerName: '',
    buyerEmail: '',
    shippingAddress: '',
    shippingCity: '',
    shippingZip: '',
    shippingPhone: '',
  });
  const idempotencyKeyRef = useRef<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const cityRef = useRef<HTMLInputElement>(null);
  const zipRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCart(readCart());
    setHydrated(true);
  }, []);

  const { totalItems, totalAmount } = useMemo(() => cartTotals(cart), [cart]);

  const validate = (): FieldErrors => {
    const next: FieldErrors = {};
    if (!form.buyerName.trim()) next.buyerName = 'Escribe tu nombre y apellidos';
    if (!form.buyerEmail.trim()) next.buyerEmail = 'Escribe tu email';
    else if (!isValidEmail(form.buyerEmail.trim())) next.buyerEmail = 'El email no parece válido';
    if (!form.shippingAddress.trim()) next.shippingAddress = 'Escribe la dirección';
    if (!form.shippingCity.trim()) next.shippingCity = 'Escribe la ciudad';
    if (!form.shippingZip.trim()) next.shippingZip = 'Escribe el código postal';
    else if (!/^[0-9]{5}$/.test(form.shippingZip.trim())) next.shippingZip = 'Usa un CP de 5 dígitos';
    return next;
  };

  const focusFirstError = (next: FieldErrors) => {
    if (next.buyerName) nameRef.current?.focus();
    else if (next.buyerEmail) emailRef.current?.focus();
    else if (next.shippingAddress) addressRef.current?.focus();
    else if (next.shippingCity) cityRef.current?.focus();
    else if (next.shippingZip) zipRef.current?.focus();
  };

  const submitOrder = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setFormError('');
    const nextErrors = validate();
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      focusFirstError(nextErrors);
      return;
    }
    if (!cart.length) {
      setFormError('Tu carrito está vacío');
      return;
    }

    setSubmitting(true);
    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current = crypto.randomUUID();
    }
    try {
      const res = await fetch('/api/shop/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          buyerName: form.buyerName.trim(),
          buyerEmail: form.buyerEmail.trim(),
          shippingAddress: form.shippingAddress.trim(),
          shippingCity: form.shippingCity.trim(),
          shippingZip: form.shippingZip.trim(),
          shippingPhone: form.shippingPhone.trim(),
          idempotencyKey: idempotencyKeyRef.current,
          items: cart.map((l) => ({
            productId: l.productId,
            quantity: l.quantity,
            size: l.size,
            color: l.color,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        idempotencyKeyRef.current = null;
        setFormError(data?.error ?? 'No se ha podido procesar el pedido. Inténtalo de nuevo.');
        return;
      }
      writeCart([]);
      setCart([]);
      if (data?.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      }
      router.push('/tienda/confirmacion/' + data.orderId);
    } catch {
      setFormError('Sin conexión. Revisa la red e inténtalo otra vez — no se cobrará dos veces.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!hydrated) {
    return (
      <div className="flex justify-center py-20" role="status" aria-live="polite" aria-busy="true">
        <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden />
      </div>
    );
  }

  if (cart.length === 0) {
    return (
      <FadeIn>
        <div className="text-center py-16 space-y-4 max-w-md mx-auto">
          <ShoppingBag className="h-12 w-12 text-muted-foreground mx-auto" aria-hidden />
          <h1 className="font-display text-2xl font-bold tracking-tight">Carrito vacío</h1>
          <p className="text-sm text-muted-foreground">Añade algo de merch antes de finalizar la compra.</p>
          <Button asChild className="gap-2">
            <Link href="/tienda">
              <ArrowLeft className="h-4 w-4" /> Volver a la tienda
            </Link>
          </Button>
        </div>
      </FadeIn>
    );
  }

  return (
    <FadeIn>
      <div className="space-y-6 pb-28 md:pb-8">
        <div>
          <Link
            href="/tienda"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
          >
            <ArrowLeft className="h-4 w-4" /> Volver a la tienda
          </Link>
          <h1 className="font-display text-2xl md:text-3xl font-bold tracking-tight">Finalizar compra</h1>
          <p className="text-muted-foreground mt-1">
            {totalItems} artículo{totalItems !== 1 ? 's' : ''} · {totalAmount.toFixed(2)}€
          </p>
        </div>

        <div className="grid lg:grid-cols-5 gap-6">
          <form onSubmit={submitOrder} className="lg:col-span-3 space-y-4" noValidate>
            <Card>
              <CardContent className="p-6 space-y-4">
                <h2 className="font-display font-bold text-lg">Datos de envío</h2>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="buyerName">Nombre y apellidos</Label>
                    <Input
                      ref={nameRef}
                      id="buyerName"
                      autoComplete="name"
                      value={form.buyerName}
                      onChange={(e) => {
                        setForm({ ...form, buyerName: e.target.value });
                        setErrors((p) => ({ ...p, buyerName: undefined }));
                      }}
                      variant={errors.buyerName ? 'error' : 'default'}
                      aria-invalid={!!errors.buyerName}
                    />
                    {errors.buyerName && (
                      <p className="text-sm text-destructive" role="alert">
                        {errors.buyerName}
                      </p>
                    )}
                  </div>
                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="buyerEmail">Email</Label>
                    <Input
                      ref={emailRef}
                      id="buyerEmail"
                      type="email"
                      autoComplete="email"
                      inputMode="email"
                      value={form.buyerEmail}
                      onChange={(e) => {
                        setForm({ ...form, buyerEmail: e.target.value });
                        setErrors((p) => ({ ...p, buyerEmail: undefined }));
                      }}
                      variant={errors.buyerEmail ? 'error' : 'default'}
                      aria-invalid={!!errors.buyerEmail}
                    />
                    {errors.buyerEmail ? (
                      <p className="text-sm text-destructive" role="alert">
                        {errors.buyerEmail}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">Te avisamos aquí del envío.</p>
                    )}
                  </div>
                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="shippingAddress">Dirección</Label>
                    <Input
                      ref={addressRef}
                      id="shippingAddress"
                      autoComplete="street-address"
                      placeholder="Calle, número, piso"
                      value={form.shippingAddress}
                      onChange={(e) => {
                        setForm({ ...form, shippingAddress: e.target.value });
                        setErrors((p) => ({ ...p, shippingAddress: undefined }));
                      }}
                      variant={errors.shippingAddress ? 'error' : 'default'}
                      aria-invalid={!!errors.shippingAddress}
                    />
                    {errors.shippingAddress && (
                      <p className="text-sm text-destructive" role="alert">
                        {errors.shippingAddress}
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="shippingCity">Ciudad</Label>
                    <Input
                      ref={cityRef}
                      id="shippingCity"
                      autoComplete="address-level2"
                      value={form.shippingCity}
                      onChange={(e) => {
                        setForm({ ...form, shippingCity: e.target.value });
                        setErrors((p) => ({ ...p, shippingCity: undefined }));
                      }}
                      variant={errors.shippingCity ? 'error' : 'default'}
                      aria-invalid={!!errors.shippingCity}
                    />
                    {errors.shippingCity && (
                      <p className="text-sm text-destructive" role="alert">
                        {errors.shippingCity}
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="shippingZip">Código postal</Label>
                    <Input
                      ref={zipRef}
                      id="shippingZip"
                      autoComplete="postal-code"
                      inputMode="numeric"
                      value={form.shippingZip}
                      onChange={(e) => {
                        setForm({ ...form, shippingZip: e.target.value });
                        setErrors((p) => ({ ...p, shippingZip: undefined }));
                      }}
                      variant={errors.shippingZip ? 'error' : 'default'}
                      aria-invalid={!!errors.shippingZip}
                    />
                    {errors.shippingZip && (
                      <p className="text-sm text-destructive" role="alert">
                        {errors.shippingZip}
                      </p>
                    )}
                  </div>
                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="shippingPhone">Teléfono (opcional)</Label>
                    <Input
                      id="shippingPhone"
                      type="tel"
                      autoComplete="tel"
                      value={form.shippingPhone}
                      onChange={(e) => setForm({ ...form, shippingPhone: e.target.value })}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            {formError && (
              <p className="text-sm text-destructive" role="alert">
                {formError}
              </p>
            )}

            <div className="hidden md:block space-y-3">
              <Button
                type="submit"
                size="lg"
                className="w-full gap-2 font-display font-semibold rounded-full shadow-lg shadow-primary/25 h-12"
                disabled={submitting}
              >
                {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : <CreditCard className="h-5 w-5" />}
                {submitting ? 'Conectando con el pago…' : `Pagar ${totalAmount.toFixed(2)}€`}
              </Button>
              <p className="text-xs text-muted-foreground flex items-start gap-1.5 justify-center">
                <Lock className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                Pago seguro. Merch bajo pedido — te confirmamos el envío por email. Un reintento no crea un cobro
                duplicado.
              </p>
            </div>
          </form>

          <aside className="lg:col-span-2">
            <Card className="lg:sticky lg:top-24">
              <CardContent className="p-6 space-y-3">
                <h2 className="font-display font-bold text-lg">Resumen</h2>
                {cart.map((line) => (
                  <div key={line.key} className="flex gap-3">
                    <div className="h-14 w-14 shrink-0 overflow-hidden rounded-md bg-muted">
                      {line.imageUrl ? (
                        <img src={line.imageUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center">
                          <ShoppingBag className="h-4 w-4 text-primary/40" />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{line.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {line.quantity} × {line.price.toFixed(2)}€
                        {[line.size, line.color].filter(Boolean).length > 0
                          ? ` · ${[line.size, line.color].filter(Boolean).join(' · ')}`
                          : ''}
                      </p>
                    </div>
                    <p className="text-sm font-semibold tabular-nums shrink-0">
                      {(line.price * line.quantity).toFixed(2)}€
                    </p>
                  </div>
                ))}
                <div className="flex justify-between border-t pt-3 font-display text-lg font-bold">
                  <span>Total</span>
                  <span className="tabular-nums">{totalAmount.toFixed(2)}€</span>
                </div>
              </CardContent>
            </Card>
          </aside>
        </div>
      </div>

      <div
        className="sticky-purchase-bar fixed bottom-0 inset-x-0 z-40 md:hidden border-t border-border/60 bg-background/95 backdrop-blur-xl shadow-[0_-8px_24px_-8px_rgb(0_0_0_/0.35)] transition-[bottom] duration-200"
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      >
        <div className="max-w-[1200px] mx-auto px-4 pt-3 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">
              {totalItems} artículo{totalItems !== 1 ? 's' : ''}
            </p>
            <p className="font-display text-xl font-bold tabular-nums leading-none">{totalAmount.toFixed(2)}€</p>
          </div>
          <Button
            type="button"
            size="lg"
            className="gap-2 font-display font-semibold rounded-full shadow-lg shadow-primary/25 h-12 px-5 shrink-0"
            disabled={submitting}
            onClick={() => void submitOrder()}
          >
            {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : <CreditCard className="h-5 w-5" />}
            {submitting ? 'Pago…' : 'Pagar'}
          </Button>
        </div>
        <p className="px-4 pt-2 text-xs text-muted-foreground flex items-center gap-1">
          <Lock className="h-3 w-3 shrink-0" />
          Pago seguro · sin doble cobro
        </p>
      </div>
    </FadeIn>
  );
}
