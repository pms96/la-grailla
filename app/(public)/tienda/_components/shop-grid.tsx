'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Product } from '@prisma/client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious, type CarouselApi } from '@/components/ui/carousel';
import { ShoppingBag, Package, Plus, Minus, Trash2, ShoppingCart } from 'lucide-react';
import { Stagger, StaggerItem, SkeletonPulse, PressScale } from '@/components/ui/animate';
import {
  type CartLine,
  cartTotals,
  parseProductOptions,
  readCart,
  writeCart,
} from '@/lib/shop-cart';

export default function ShopGrid() {
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [selected, setSelected] = useState<Product | null>(null);
  const [chosenSize, setChosenSize] = useState<string>('');
  const [chosenColor, setChosenColor] = useState<string>('');
  const [optionError, setOptionError] = useState<string>('');
  const [carouselApi, setCarouselApi] = useState<CarouselApi>();
  const [carouselIndex, setCarouselIndex] = useState(0);

  const loadProducts = () => {
    setLoading(true);
    setLoadError(false);
    fetch('/api/products')
      .then(async (r) => {
        if (!r.ok) throw new Error('products_failed');
        return r.json();
      })
      .then((data) => setProducts(Array.isArray(data) ? data : []))
      .catch(() => {
        setProducts([]);
        setLoadError(true);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadProducts();
  }, []);

  useEffect(() => {
    setCart(readCart());
  }, []);

  useEffect(() => {
    writeCart(cart);
  }, [cart]);

  const { totalItems, totalAmount } = useMemo(() => cartTotals(cart), [cart]);

  const openProduct = (product: Product) => {
    setSelected(product);
    // Sin preselección: el comprador confirma talla/color a propósito.
    setChosenSize('');
    setChosenColor('');
    setOptionError('');
    setCarouselIndex(0);
  };

  useEffect(() => {
    if (!carouselApi) return;
    setCarouselIndex(carouselApi.selectedScrollSnap());
    const onSelect = () => setCarouselIndex(carouselApi.selectedScrollSnap());
    carouselApi.on('select', onSelect);
    return () => {
      carouselApi.off('select', onSelect);
    };
  }, [carouselApi]);

  const addToCart = () => {
    if (!selected) return;
    const sizes = parseProductOptions(selected.sizes);
    const colors = parseProductOptions(selected.colors);
    if (sizes.length > 0 && !chosenSize) {
      setOptionError('Elige una talla');
      return;
    }
    if (colors.length > 0 && !chosenColor) {
      setOptionError('Elige un color');
      return;
    }
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
    setOptionError('');
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

  const goCheckout = () => {
    if (!cart.length) return;
    setCartOpen(false);
    router.push('/tienda/checkout');
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

  if (loadError) {
    return (
      <div className="rounded-2xl border border-destructive/30 bg-destructive/5 px-6 py-16 text-center mt-6" role="alert">
        <Package className="h-12 w-12 text-destructive/60 mx-auto mb-4" aria-hidden />
        <h2 className="font-display text-xl font-bold tracking-tight mb-2">No hemos podido cargar la tienda</h2>
        <p className="text-muted-foreground max-w-md mx-auto mb-6">
          Parece un fallo de conexión o del servidor — no es que el catálogo esté vacío.
        </p>
        <Button onClick={loadProducts} className="font-display font-semibold gap-2">
          Reintentar
        </Button>
      </div>
    );
  }

  if ((products?.length ?? 0) === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border/80 bg-muted/20 px-6 py-20 text-center mt-6">
        <Package className="h-12 w-12 text-primary/40 mx-auto mb-4" aria-hidden />
        <h2 className="font-display text-xl font-bold tracking-tight mb-2">Catálogo en preparación</h2>
        <p className="text-muted-foreground max-w-md mx-auto">
          Ahora mismo no hay productos a la venta. Mientras tanto, las entradas de los eventos están el plan.
        </p>
        <Button asChild variant="outline" className="mt-6 font-display font-semibold">
          <Link href="/eventos">Ver eventos</Link>
        </Button>
      </div>
    );
  }

  const selectedSizes = parseProductOptions(selected?.sizes);
  const selectedColors = parseProductOptions(selected?.colors);

  return (
    <>
      {/* Desktop: acceso al carrito arriba a la derecha */}
      <div className="hidden md:flex justify-end mt-6">
        <Button variant="outline" className="gap-2" onClick={() => setCartOpen(true)}>
          <ShoppingCart className="h-4 w-4" />
          Carrito
          {totalItems > 0 && <Badge className="ml-1">{totalItems}</Badge>}
        </Button>
      </div>

      <Stagger staggerDelay={0.08}>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mt-6 pb-24 md:pb-0">
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
                  {product?.category && (
                    <Badge variant="outline" className="text-xs mb-2 w-fit">
                      {product.category}
                    </Badge>
                  )}
                  {product?.description && (
                    <p className="text-sm text-muted-foreground line-clamp-2 mb-3">{product.description}</p>
                  )}
                  {parseProductOptions(product?.sizes).length > 0 && (
                    <p className="text-xs text-muted-foreground mb-3">
                      Tallas: {parseProductOptions(product.sizes).join(', ')}
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

      {/* FAB móvil — zona del pulgar */}
      <div
        className="sticky-purchase-bar fixed bottom-0 inset-x-0 z-40 md:hidden pointer-events-none transition-[bottom] duration-200"
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      >
        <div className="max-w-[1200px] mx-auto px-4 flex justify-end pointer-events-auto">
          <Button
            size="lg"
            onClick={() => setCartOpen(true)}
            className="gap-2 font-display font-semibold rounded-full h-14 px-5 shadow-lg shadow-primary/30"
            aria-label={totalItems > 0 ? `Abrir carrito, ${totalItems} artículos` : 'Abrir carrito'}
          >
            <ShoppingCart className="h-5 w-5" />
            Carrito
            {totalItems > 0 && (
              <Badge className="bg-lima text-accent-foreground border-0 ml-0.5">{totalItems}</Badge>
            )}
          </Button>
        </div>
      </div>

      <Sheet open={cartOpen} onOpenChange={setCartOpen}>
        <SheetContent className="w-full sm:max-w-md flex flex-col p-0">
          <SheetHeader className="px-6 pt-6 pb-2">
            <SheetTitle>Tu carrito</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
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
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => changeQty(line.key, -1)}
                        aria-label="Quitar una unidad"
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </Button>
                    </PressScale>
                    <span className="w-6 text-center text-sm font-mono tabular-nums">{line.quantity}</span>
                    <PressScale>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => changeQty(line.key, 1)}
                        aria-label="Añadir una unidad"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </Button>
                    </PressScale>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 ml-auto text-muted-foreground"
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
          <div className="border-t px-6 py-4 space-y-3" style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Total</span>
              <span className="font-display text-xl font-bold tabular-nums">{totalAmount.toFixed(2)}€</span>
            </div>
            <Button className="w-full font-display font-semibold" disabled={!cart.length} onClick={goCheckout}>
              Finalizar compra
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <Dialog open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{selected?.name ?? ''}</DialogTitle>
            <DialogDescription>
              {selected?.description ?? 'Elige las opciones y añade al carrito.'}
            </DialogDescription>
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
                <div className="flex flex-wrap gap-2" role="group" aria-label="Talla">
                  {selectedSizes.map((size) => (
                    <Button
                      key={size}
                      type="button"
                      variant={chosenSize === size ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => {
                        setChosenSize(size);
                        setOptionError('');
                      }}
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
                <div className="flex flex-wrap gap-2" role="group" aria-label="Color">
                  {selectedColors.map((color) => (
                    <Button
                      key={color}
                      type="button"
                      variant={chosenColor === color ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => {
                        setChosenColor(color);
                        setOptionError('');
                      }}
                    >
                      {color}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            {optionError && (
              <p className="text-sm text-destructive" role="alert">
                {optionError}
              </p>
            )}
            <div className="flex items-center justify-between gap-3 pt-2">
              <span className="font-display text-xl font-bold tabular-nums">
                {(selected?.price ?? 0).toFixed(2)}€
              </span>
              <PressScale>
                <Button onClick={addToCart} className="gap-2">
                  <ShoppingCart className="h-4 w-4" /> Añadir al carrito
                </Button>
              </PressScale>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
