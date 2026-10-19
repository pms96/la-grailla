'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, ShoppingBag } from 'lucide-react';
import { addToCart, openCart, readCart, saveCart } from '@/lib/shop/drop-cart';
import { lowStockNote, variantStock, type ShopProductView } from '@/lib/shop/product-view';
import '@/components/templates/drop.css';

/**
 * Compra desde la ficha del producto: talla y color (si los tiene), stock de la combinación elegida y el botón de añadir, que confirma con un
 * microestado («Añadido») sin sacar al comprador de la página. El carrito es el de siempre (mismo almacenamiento y mismas reglas que la tienda
 * clásica); el servidor vuelve a comprobar todo al crear el pedido.
 */
export function ProductBuy({ product }: { product: ShopProductView }) {
  const [size, setSize] = useState('');
  const [color, setColor] = useState('');
  const [error, setError] = useState('');
  const [added, setAdded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timer.current), []);

  // Una opción sale tachada solo cuando ya se sabe que esa combinación está agotada (con la otra opción elegida, o si es la única).
  const soldOut = (s: string, c: string) => {
    const stock = variantStock(product, s, c);
    return stock !== null && stock <= 0;
  };
  const sizeDisabled = (s: string) => (product.colors.length === 0 ? soldOut(s, '') : color ? soldOut(s, color) : false);
  const colorDisabled = (c: string) => (product.sizes.length === 0 ? soldOut('', c) : size ? soldOut(size, c) : false);

  const stockNote = (product.sizes.length === 0 || size) && (product.colors.length === 0 || color) ? lowStockNote(variantStock(product, size, color)) : null;

  const add = () => {
    const res = addToCart(readCart(), product, size, color);
    if (res.error) {
      setError(res.error);
      return;
    }
    setError('');
    saveCart(res.cart);
    setAdded(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setAdded(false), 1800);
  };

  const group = (label: string, options: string[], value: string, pick: (v: string) => void, disabled: (v: string) => boolean) => (
    <div className="space-y-2">
      <p className="dp-label" id={`opt-${label}`}>
        {label}
      </p>
      <div className="flex flex-wrap gap-2" role="group" aria-labelledby={`opt-${label}`}>
        {options.map((o) => (
          <button
            key={o}
            type="button"
            className="dp-chip"
            aria-pressed={value === o}
            disabled={disabled(o)}
            onClick={() => {
              pick(o);
              setError('');
            }}
          >
            {o}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      {product.sizes.length > 0 && group('Talla', product.sizes, size, setSize, sizeDisabled)}
      {product.colors.length > 0 && group('Color', product.colors, color, setColor, colorDisabled)}

      <div className="space-y-3">
        <button type="button" className="dp-add" data-state={added ? 'added' : 'idle'} onClick={add} disabled={!product.inStock}>
          <span data-when="idle">
            <ShoppingBag className="h-5 w-5" aria-hidden />
            {product.inStock ? 'Añadir al carrito' : 'Agotado'}
          </span>
          <span data-when="added" aria-hidden>
            <Check className="h-5 w-5" /> Añadido
          </span>
        </button>
        {/* Región viva: anuncia el resultado a lectores de pantalla sin mover el foco. */}
        <p className="min-h-[1.25rem] text-sm" role="status" aria-live="polite">
          {error ? <span className="text-destructive">{error}</span> : added ? 'Añadido al carrito' : stockNote}
        </p>
        {added && (
          <button type="button" className="text-sm font-medium underline underline-offset-4" onClick={openCart}>
            Ver carrito
          </button>
        )}
      </div>
    </div>
  );
}
