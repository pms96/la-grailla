'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Minus, Plus, ShoppingBag, ShoppingCart, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cartTotals, type CartLine } from '@/lib/shop-cart';
import { CART_CHANGED_EVENT, CART_OPEN_EVENT, changeQuantity, readCart, removeLine, saveCart } from '@/lib/shop/drop-cart';
import { variantStock, type ProductVariantView } from '@/lib/shop/product-view';
import '@/components/templates/drop.css';

/**
 * Carrito de la tienda de la plantilla «drop»: un botón flotante con el número de artículos y, al pulsarlo, un panel con las líneas, las
 * cantidades y el total. Lee y escribe el MISMO carrito del navegador que el resto de la tienda y que el pago (clave y formato de siempre), y
 * se entera de los cambios de otros componentes de la página por un evento. `stock` (variantes por producto) permite avisar de que no quedan más
 * unidades; sin él no hay límite en el navegador (el servidor lo comprueba igualmente al crear el pedido).
 */
export function DropCart({ stock }: { stock?: Record<string, ProductVariantView[]> }) {
  const [cart, setCart] = useState<CartLine[]>([]);
  const [open, setOpen] = useState(false);
  const [bump, setBump] = useState(false);
  const previous = useRef(0);

  useEffect(() => {
    const sync = () => setCart(readCart());
    // Lo que ya había en el carrito al abrir la página no cuenta como «sumar»: se recuerda para que el botón no salte al cargar.
    const first = readCart();
    previous.current = cartTotals(first).totalItems;
    setCart(first);
    const openIt = () => setOpen(true);
    window.addEventListener(CART_CHANGED_EVENT, sync);
    window.addEventListener('storage', sync);
    window.addEventListener(CART_OPEN_EVENT, openIt);
    return () => {
      window.removeEventListener(CART_CHANGED_EVENT, sync);
      window.removeEventListener('storage', sync);
      window.removeEventListener(CART_OPEN_EVENT, openIt);
    };
  }, []);

  const { totalItems, totalAmount } = cartTotals(cart);

  // Un salto breve del botón cuando suben los artículos.
  useEffect(() => {
    const grew = totalItems > previous.current;
    previous.current = totalItems;
    if (!grew) return;
    setBump(true);
    const t = setTimeout(() => setBump(false), 360);
    return () => clearTimeout(t);
  }, [totalItems]);

  const stockOf = (line: CartLine) => {
    const variants = stock?.[line.productId];
    return variants ? variantStock({ variants }, line.size ?? '', line.color ?? '') : null;
  };
  const commit = (next: CartLine[]) => {
    setCart(next);
    saveCart(next);
  };
  const change = (key: string, delta: number) => {
    const res = changeQuantity(cart, key, delta, stockOf);
    if (res.error) toast.error(res.error);
    else commit(res.cart);
  };

  return (
    <>
      <button type="button" className="dp-cart" data-bump={bump} onClick={() => setOpen(true)} aria-label={totalItems > 0 ? `Abrir carrito, ${totalItems} artículo${totalItems === 1 ? '' : 's'}` : 'Abrir carrito'}>
        <ShoppingCart className="h-5 w-5" aria-hidden />
        Carrito
        {totalItems > 0 && <span className="dp-cart-count">{totalItems}</span>}
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="flex w-full flex-col p-0 sm:max-w-md">
          <SheetHeader className="px-6 pb-2 pt-6">
            <SheetTitle className="dp-heading !text-3xl">Tu carrito</SheetTitle>
          </SheetHeader>
          <div className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
            {cart.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">Tu carrito está vacío</p>}
            {cart.map((line) => (
              <div key={line.key} className="flex gap-3 rounded-lg bg-muted/60 p-3">
                <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md bg-muted">
                  {line.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={line.imageUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <ShoppingBag className="h-5 w-5 text-muted-foreground" aria-hidden />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{line.name}</p>
                  <p className="text-xs text-muted-foreground">{[line.size, line.color].filter(Boolean).join(' · ') || 'Estándar'}</p>
                  <div className="mt-2 flex items-center gap-2">
                    <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => change(line.key, -1)} aria-label={`Quitar una unidad de ${line.name}`}>
                      <Minus className="h-3.5 w-3.5" />
                    </Button>
                    <span className="w-6 text-center font-mono text-sm tabular-nums">{line.quantity}</span>
                    <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => change(line.key, 1)} aria-label={`Añadir una unidad de ${line.name}`}>
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="ml-auto h-8 w-8 text-muted-foreground" onClick={() => commit(removeLine(cart, line.key))} aria-label={`Quitar ${line.name} del carrito`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <p className="shrink-0 text-sm font-semibold tabular-nums">{(line.price * line.quantity).toFixed(2)}€</p>
              </div>
            ))}
          </div>
          <div className="space-y-3 border-t px-6 py-4" style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Total</span>
              <span className="font-display text-xl font-bold tabular-nums">{totalAmount.toFixed(2)}€</span>
            </div>
            {cart.length > 0 ? (
              <Link href="/tienda/checkout" className="dp-add" onClick={() => setOpen(false)}>
                Finalizar compra
              </Link>
            ) : (
              <button type="button" className="dp-add" disabled>
                Finalizar compra
              </button>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
