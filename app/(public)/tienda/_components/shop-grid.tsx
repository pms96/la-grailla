'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Product } from '@prisma/client';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious, type CarouselApi } from '@/components/ui/carousel';
import { ShoppingBag, Loader2, Package, Plus, Minus, Trash2, ShoppingCart } from 'lucide-react';
import { Stagger, StaggerItem, SkeletonPulse, PressScale } from '@/components/ui/animate';

type CartLine = {
  key: string;
  productId: string;
  name: string;
  price: number;
  imageUrl?: string | null;
  size?: string | null;
  color?: string | null;
  quantity: number;
};

function parseOptions(value?: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

export default function ShopGrid() {
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [selected, setSelected] = useState<Product | null>(null);
  const [chosenSize, setChosenSize] = useState<string>('');
  const [chosenColor, setChosenColor] = useState<string>('');
  const [carouselApi, setCarouselApi] = useState<CarouselApi>();
  const [carouselIndex, setCarouselIndex] = useState(0);
  const [checkout, setCheckout] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string>('');
  const [form, setForm] = useState({
    buyerName: '',
    buyerEmail: '',
    shippingAddress: '',
    shippingCity: '',
    shippingZip: '',
    shippingPhone: '',
  });

  useEffect(() => {
    fetch('/api/products')
      .then((r) => r.json())
      .then((data) => setProducts(data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem('lagrailla_cart');
      if (raw) setCart(JSON.parse(raw));
    } catch {}
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem('lagrailla_cart', JSON.stringify(cart));
    } catch {}
  }, [cart]);

  const totalItems = useMemo(() => cart.reduce((sum, l) => sum + l.quantity, 0), [cart]);
  const totalAmount = useMemo(() => cart.reduce((sum, l) => sum + l.price * l.quantity, 0), [cart]);

  const openProduct = (product: Product) => {
    const sizes = parseOptions(product?.sizes);
    const colors = parseOptions(product?.colors);
    setSelected(product);
    setChosenSize(sizes[0] ?? '');
    setChosenColor(colors[0] ?? '');
    setCarouselIndex(0);
  };

  useEffect(() => {
    if (!carouselApi) return;
    setCarouselIndex(carouselApi.selectedScrollSnap());
    const onSelect = () => setCarouselIndex(carouselApi.selectedScrollSnap());
    carouselApi.on('select', onSelect);
    return () => { carouselApi.off('select', onSelect); };
  }, [carouselApi]);

  const addToCart = () => {
    if (!selected) return;
    const key = [selected.id, chosenSize, chosenColor].join('|');
    setCart((prev) => {
      const existing = prev.find((l) => l.key === key);
      if (existing) {
        return prev.map((l) => (l.key === key ? { ...l, quantity: l.quantity + 1 } : l));
      }
      return [
        ...prev,
        {
          key,
          productId: selected.id,
          name: selected.name,
          price: selected.price ?? 0,
          imageUrl: selected.imageUrl,
          size: chosenSize || null,
          color: chosenColor || null,
          quantity: 1,
        },
      ];
    });
    setSelected(null);
    setCartOpen(true);
  };

  const changeQty = (key: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((l) => (l.key === key ? { ...l, quantity: l.quantity + delta } : l))
        .filter((l) => l.quantity > 0)
    );
  };

  const removeLine = (key: string) => setCart((prev) => prev.filter((l) => l.key !== key));

  const submitOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    if (!cart.length) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/shop/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
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
        setFormError(data?.error ?? 'No se ha podido procesar el pedido');
        return;
      }
      setCart([]);
      setCheckout(false);
      setCartOpen(false);
      if (data?.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      }
      router.push('/tienda/confirmacion/' + data.orderId);
    } catch {
      setFormError('Error de conexión. Inténtalo de nuevo.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mt-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="overflow-hidden rounded-lg border h-full flex flex-col">
            <SkeletonPulse className="aspect-square w-full rounded-none" />
            <div className="p-5 space-y-3">
              <SkeletonPulse className="h-5 w-3/4" />
              <SkeletonPulse className="h-4 w-1/3" />
              <div className="flex items-center justify-between pt-2">
                <SkeletonPulse className="h-6 w-16" />
                <SkeletonPulse className="h-8 w-20 rounded-lg" />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if ((products?.length ?? 0) === 0) {
    return (
      <div className="text-center py-20">
        <Package className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
        <p className="text-muted-foreground">No hay productos disponibles en este momento</p>
      </div>
    );
  }

  const selectedSizes = parseOptions(selected?.sizes);
  const selectedColors = parseOptions(selected?.colors);

  return (
    <>
      <div className="flex justify-end mt-6">
        <Sheet open={cartOpen} onOpenChange={setCartOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" className="gap-2">
              <ShoppingCart className="h-4 w-4" />
              Carrito
              {totalItems > 0 && <Badge className="ml-1">{totalItems}</Badge>}
            </Button>
          </SheetTrigger>
          <SheetContent className="w-full sm:max-w-md flex flex-col">
            <SheetHeader>
              <SheetTitle>Tu carrito</SheetTitle>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto py-4 space-y-3">
              {cart.length === 0 && (
                <p className="text-sm text-muted-foreground py-10 text-center">Tu carrito está vacío</p>
              )}
              {cart.map((line) => (
                <div key={line.key} className="flex gap-3 rounded-lg bg-muted/50 p-3">
                  <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md bg-muted">
                    {line.imageUrl ? (
                      <img src={line.imageUrl} alt={line.name} className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        <ShoppingBag className="h-5 w-5 text-primary/40" />
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{line.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {[line.size, line.color].filter(Boolean).join(' · ') || 'Estándar'}
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <PressScale>
                        <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => changeQty(line.key, -1)}>
                          <Minus className="h-3 w-3" />
                        </Button>
                      </PressScale>
                      <span className="w-6 text-center text-sm">{line.quantity}</span>
                      <PressScale>
                        <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => changeQty(line.key, 1)}>
                          <Plus className="h-3 w-3" />
                        </Button>
                      </PressScale>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 ml-auto text-muted-foreground"
                        onClick={() => removeLine(line.key)}
                        aria-label="Quitar del carrito"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  <p className="font-semibold text-sm shrink-0">{(line.price * line.quantity).toFixed(2)}€</p>
                </div>
              ))}
            </div>
            <div className="border-t pt-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Total</span>
                <span className="font-display text-xl font-bold">{totalAmount.toFixed(2)}€</span>
              </div>
              <Button className="w-full" disabled={!cart.length} onClick={() => setCheckout(true)}>
                Finalizar compra
              </Button>
            </div>
          </SheetContent>
        </Sheet>
      </div>

      <Stagger staggerDelay={0.08}>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mt-6">
          {products.map((product, index) => (
            <StaggerItem key={product?.id ?? `prod-${index}`}>
              <Card variant="interactive" className="overflow-hidden group h-full flex flex-col">
                <div className="aspect-square bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center">
                  {product?.imageUrl ? (
                    <img src={product.imageUrl} alt={product?.name ?? ''} className="object-cover w-full h-full" />
                  ) : (
                    <ShoppingBag className="h-12 w-12 text-primary/40" />
                  )}
                </div>
                <CardContent className="p-5 flex flex-col flex-1">
                  <h3 className="font-display font-bold text-lg mb-1 group-hover:text-primary transition-colors">
                    {product?.name ?? ''}
                  </h3>
                  {product?.category && <Badge variant="outline" className="text-xs mb-2 w-fit">{product.category}</Badge>}
                  {product?.description && (
                    <p className="text-sm text-muted-foreground line-clamp-2 mb-3">{product.description}</p>
                  )}
                  {parseOptions(product?.sizes).length > 0 && (
                    <p className="text-xs text-muted-foreground mb-3">
                      Tallas: {parseOptions(product.sizes).join(', ')}
                    </p>
                  )}
                  <div className="mt-auto flex items-center justify-between gap-2">
                    <p className="font-bold text-primary text-lg">{(product?.price ?? 0).toFixed(2)}€</p>
                    <Button size="sm" className="gap-2" onClick={() => openProduct(product)}>
                      <Plus className="h-3.5 w-3.5" /> Añadir
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </StaggerItem>
          ))}
        </div>
      </Stagger>

      <Dialog open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{selected?.name ?? ''}</DialogTitle>
            <DialogDescription>{selected?.description ?? 'Elige las opciones y añade al carrito.'}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {(() => {
              const gallery = [selected?.imageUrl, ...(selected?.images ?? [])].filter(Boolean) as string[];
              if (gallery.length === 0) return null;
              return (
                <Carousel setApi={setCarouselApi}>
                  <CarouselContent>
                    {gallery.map((src, i) => (
                      <CarouselItem key={i}>
                        <div className="relative aspect-square w-full overflow-hidden rounded-lg bg-muted">
                          <img src={src} alt={selected?.name ?? ''} className="h-full w-full object-cover" />
                        </div>
                      </CarouselItem>
                    ))}
                  </CarouselContent>
                  {gallery.length > 1 && (
                    <>
                      <CarouselPrevious className="left-2 -translate-y-1/2 rounded-full bg-background/80" />
                      <CarouselNext className="right-2 -translate-y-1/2 rounded-full bg-background/80" />
                      <span className="absolute bottom-2 right-2 font-mono text-xs px-2 py-0.5 rounded-full bg-background/80 border border-border">
                        {carouselIndex + 1} / {gallery.length}
                      </span>
                    </>
                  )}
                </Carousel>
              );
            })()}
            {selectedSizes.length > 0 && (
              <div className="space-y-2">
                <Label>Talla</Label>
                <div className="flex flex-wrap gap-2">
                  {selectedSizes.map((size) => (
                    <Button
                      key={size}
                      type="button"
                      variant={chosenSize === size ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setChosenSize(size)}
                    >
                      {size}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            {selectedColors.length > 0 && (
              <div className="space-y-2">
                <Label>Color</Label>
                <div className="flex flex-wrap gap-2">
                  {selectedColors.map((color) => (
                    <Button
                      key={color}
                      type="button"
                      variant={chosenColor === color ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setChosenColor(color)}
                    >
                      {color}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            <div className="flex items-center justify-between pt-2">
              <span className="font-display text-xl font-bold">{(selected?.price ?? 0).toFixed(2)}€</span>
              <PressScale>
                <Button onClick={addToCart} className="gap-2">
                  <ShoppingCart className="h-4 w-4" /> Añadir al carrito
                </Button>
              </PressScale>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={checkout} onOpenChange={setCheckout}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Datos de envío</DialogTitle>
            <DialogDescription>Completa tus datos para finalizar el pedido.</DialogDescription>
          </DialogHeader>
          <form onSubmit={submitOrder} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="buyerName">Nombre y apellidos</Label>
                <Input
                  id="buyerName"
                  required
                  value={form.buyerName}
                  onChange={(e) => setForm({ ...form, buyerName: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="buyerEmail">Email</Label>
                <Input
                  id="buyerEmail"
                  type="email"
                  required
                  value={form.buyerEmail}
                  onChange={(e) => setForm({ ...form, buyerEmail: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="shippingAddress">Dirección</Label>
              <Input
                id="shippingAddress"
                required
                placeholder="Calle, número, piso"
                value={form.shippingAddress}
                onChange={(e) => setForm({ ...form, shippingAddress: e.target.value })}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="shippingCity">Ciudad</Label>
                <Input
                  id="shippingCity"
                  required
                  value={form.shippingCity}
                  onChange={(e) => setForm({ ...form, shippingCity: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="shippingZip">Código postal</Label>
                <Input
                  id="shippingZip"
                  required
                  inputMode="numeric"
                  pattern="[0-9]{5}"
                  title="Introduce un código postal de 5 dígitos"
                  value={form.shippingZip}
                  onChange={(e) => setForm({ ...form, shippingZip: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="shippingPhone">Teléfono (opcional)</Label>
              <Input
                id="shippingPhone"
                type="tel"
                value={form.shippingPhone}
                onChange={(e) => setForm({ ...form, shippingPhone: e.target.value })}
              />
            </div>

            <div className="rounded-lg bg-muted/50 p-4 space-y-1">
              {cart.map((line) => (
                <div key={line.key} className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    {line.quantity} x {line.name}
                    {[line.size, line.color].filter(Boolean).length > 0
                      ? ' (' + [line.size, line.color].filter(Boolean).join(', ') + ')'
                      : ''}
                  </span>
                  <span>{(line.price * line.quantity).toFixed(2)}€</span>
                </div>
              ))}
              <div className="flex justify-between border-t pt-2 mt-2 font-bold">
                <span>Total</span>
                <span>{totalAmount.toFixed(2)}€</span>
              </div>
            </div>

            {formError && <p className="text-sm text-destructive">{formError}</p>}

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Confirmar pedido
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
