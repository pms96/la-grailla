'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import type { Product, ProductVariant, Temporada } from '@prisma/client';
import type { WithNumberFields } from '@/lib/prisma';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Plus, Pencil, Trash2, ShoppingBag, X } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layouts/page-header';
import { useBrand } from '@/components/brand-provider';
import { ImageUploadField } from '@/app/admin/_components/image-upload-field';
import { expandVariantKeys } from '@/lib/shop-cart';
import { buildVariantsPayload, variantKey } from '@/lib/product-variants-payload';
import { TemporadaSelector } from '@/app/admin/compras/_components/temporada-selector';

type ProductWithVariants = WithNumberFields<Product, 'price'> & { variants?: ProductVariant[] };

type ProductFormState = {
  name: string;
  description: string;
  price: number | string;
  imageUrl: string;
  images: string[];
  category: string;
  sizes: string;
  colors: string;
  isActive: 'true' | 'false';
  stockByKey: Record<string, number>;
  temporadaId: string | null;
};

const EMPTY: ProductFormState = {
  name: '',
  description: '',
  price: 0,
  imageUrl: '',
  images: [],
  category: '',
  sizes: '',
  colors: '',
  isActive: 'true',
  stockByKey: {},
  temporadaId: null,
};

export default function ProductosPage() {
  const { legacy } = useBrand();
  const [products, setProducts] = useState<ProductWithVariants[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProductWithVariants | null>(null);
  const [form, setForm] = useState<ProductFormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [stockTouched, setStockTouched] = useState(false);
  // Stock de cada variante tal y como se cargó al abrir el diálogo: sirve para enviar solo lo que el admin cambió y como `expectedStock`.
  const [originalStock, setOriginalStock] = useState<Record<string, number>>({});
  // Stock actual que devuelve el servidor cuando una variante cambió mientras se editaba (409); se muestra junto al campo.
  const [stockConflicts, setStockConflicts] = useState<Record<string, number>>({});
  const [temporadas, setTemporadas] = useState<Temporada[]>([]);
  // Las temporadas son de Contabilidad: sin ese módulo la API responde 404 y el selector no se muestra.
  const [temporadasDisponibles, setTemporadasDisponibles] = useState(false);

  const fetchProducts = useCallback(() => {
    fetch('/api/admin/products')
      .then((r) => r.json())
      .then((d) => setProducts(Array.isArray(d) ? d : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  useEffect(() => {
    fetch('/api/admin/compras/temporadas')
      .then((r) => {
        setTemporadasDisponibles(r.ok);
        return r.json();
      })
      .then((d) => setTemporadas(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, []);

  const updateField = <K extends keyof ProductFormState>(key: K, value: ProductFormState[K]) =>
    setForm((prev) => ({ ...(prev ?? EMPTY), [key]: value }));

  const handleChange = (key: 'name' | 'description' | 'category' | 'imageUrl' | 'sizes' | 'colors') =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => updateField(key, e?.target?.value ?? '');

  const matrixKeys = useMemo(
    () => expandVariantKeys(form.sizes, form.colors),
    [form.sizes, form.colors]
  );

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY);
    setStockTouched(false);
    setOriginalStock({});
    setStockConflicts({});
    setDialogOpen(true);
  };

  const openEdit = (p: ProductWithVariants) => {
    setEditing(p);
    const stockByKey: Record<string, number> = {};
    for (const v of p.variants ?? []) {
      stockByKey[variantKey(v.size, v.color)] = v.stock;
    }
    setForm({
      name: p?.name ?? '',
      description: p?.description ?? '',
      price: p?.price ?? 0,
      imageUrl: p?.imageUrl ?? '',
      images: p?.images ?? [],
      category: p?.category ?? '',
      sizes: p?.sizes ?? '',
      colors: p?.colors ?? '',
      isActive: p?.isActive === false ? 'false' : 'true',
      stockByKey,
      temporadaId: p?.temporadaId ?? null,
    });
    setStockTouched(false);
    setOriginalStock(stockByKey);
    setStockConflicts({});
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!form?.name?.trim()) {
      toast.error('El producto necesita un nombre');
      return;
    }
    setSaving(true);
    try {
      const sizesChanged = editing ? (form.sizes ?? '') !== (editing.sizes ?? '') : false;
      const colorsChanged = editing ? (form.colors ?? '') !== (editing.colors ?? '') : false;
      // Solo mandamos `variants` si hay algo real que sincronizar, y solo las filas que el admin ha cambiado
      // (con `expectedStock` para el control optimista): ver buildVariantsPayload.
      const variants = buildVariantsPayload({
        editing: !!editing,
        sizes: form.sizes ?? '',
        colors: form.colors ?? '',
        sizesChanged,
        colorsChanged,
        stockByKey: form.stockByKey,
        originalStock,
        stockTouched,
      });
      const payload = {
        name: form.name.trim(),
        description: form.description ?? '',
        price: Number(form.price) || 0,
        imageUrl: form.imageUrl ?? '',
        images: (form.images ?? []).filter(Boolean),
        category: form.category ?? '',
        sizes: form.sizes ?? '',
        colors: form.colors ?? '',
        isActive: form.isActive === 'true',
        temporadaId: form.temporadaId,
        ...(variants ? { variants } : {}),
      };
      const url = editing ? '/api/admin/products/' + editing.id : '/api/admin/products';
      const res = await fetch(url, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        if (res.status === 409) {
          // El stock cambió mientras se editaba (ventas): no se ha guardado nada y el formulario conserva lo escrito.
          const body = await res.json().catch(() => null);
          const conflicts: { size: string; color: string; current: number | null }[] = body?.conflicts ?? [];
          const current: Record<string, number> = {};
          const nextOriginal = { ...originalStock };
          for (const c of conflicts) {
            const key = variantKey(c.size, c.color);
            if (c.current === null) {
              delete nextOriginal[key]; // la variante ya no existe: al reintentar se creará como combinación nueva
            } else {
              current[key] = c.current;
              nextOriginal[key] = c.current;
            }
          }
          setStockConflicts(current);
          setOriginalStock(nextOriginal);
          fetchProducts();
          toast.error(body?.error ?? 'El stock ha cambiado mientras editabas. Revisa los valores y vuelve a guardar.', {
            duration: 12000,
          });
          return;
        }
        toast.error('No se pudo guardar el producto');
        return;
      }
      toast.success(editing ? 'Producto actualizado' : 'Producto creado');
      setDialogOpen(false);
      fetchProducts();
    } catch {
      toast.error('Error de conexión');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('¿Retirar este producto de la tienda?')) return;
    const res = await fetch('/api/admin/products/' + id, { method: 'DELETE' });
    if (res.ok) {
      toast.success('Producto retirado de la tienda');
      fetchProducts();
    } else {
      toast.error('No se pudo retirar');
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <PageHeader title="Productos" description="Merchandising de la tienda" />
        <Button onClick={openCreate} className="gap-2">
          <Plus className="h-4 w-4" /> Nuevo producto
        </Button>
      </div>

      {products.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-muted-foreground">
            <ShoppingBag className="h-8 w-8 mx-auto mb-3 opacity-50" />
            Todavía no hay productos.
          </CardContent>
        </Card>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {products.map((p) => {
            const totalStock = (p.variants ?? []).reduce((sum, v) => sum + (v.stock ?? 0), 0);
            const hasVariants = (p.variants ?? []).length > 0;
            return (
              <Card key={p?.id} className={p?.isActive === false ? 'opacity-60' : ''}>
                <CardContent className="p-4 space-y-3">
                  <div className="relative aspect-square w-full rounded-md overflow-hidden bg-muted">
                    {p?.imageUrl ? (
                      <Image src={p.imageUrl} alt={p?.name ?? 'Producto'} fill className="object-cover" />
                    ) : (
                      <div className="flex h-full items-center justify-center text-muted-foreground">
                        <ShoppingBag className="h-8 w-8" />
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-semibold leading-tight">{p?.name ?? ''}</p>
                      <span className="font-bold shrink-0">{(p?.price ?? 0).toFixed(2)} €</span>
                    </div>
                    <p className="text-xs text-muted-foreground">{p?.category || 'Sin categoría'}</p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {p?.isActive === false && <Badge variant="secondary">Oculto</Badge>}
                    {hasVariants && (
                      <Badge variant={totalStock > 0 ? 'outline' : 'destructive'}>
                        Stock: {totalStock}
                      </Badge>
                    )}
                    {String(p?.sizes ?? '')
                      .split(',')
                      .filter(Boolean)
                      .map((s: string) => (
                        <Badge key={'s' + s} variant="outline">
                          {s.trim()}
                        </Badge>
                      ))}
                    {String(p?.colors ?? '')
                      .split(',')
                      .filter(Boolean)
                      .map((c: string) => (
                        <Badge key={'c' + c} variant="outline">
                          {c.trim()}
                        </Badge>
                      ))}
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" className="flex-1 gap-2" onClick={() => openEdit(p)}>
                      <Pencil className="h-3.5 w-3.5" /> Editar
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => handleDelete(p.id)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? 'Editar producto' : 'Nuevo producto'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Nombre *</Label>
              <Input value={form?.name ?? ''} onChange={handleChange('name')} className="mt-1" />
            </div>
            <div>
              <Label>Descripción</Label>
              <Textarea
                value={form?.description ?? ''}
                onChange={handleChange('description')}
                className="mt-1"
                rows={3}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Precio (€)</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={form?.price ?? 0}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    updateField('price', e?.target?.value ?? 0)
                  }
                  className="mt-1"
                />
              </div>
              <div>
                <Label>Categoría</Label>
                <Input
                  value={form?.category ?? ''}
                  onChange={handleChange('category')}
                  className="mt-1"
                  placeholder="Camisetas"
                />
              </div>
            </div>
            <div>
              <Label>Imagen principal</Label>
              <ImageUploadField
                value={form?.imageUrl ?? ''}
                onChange={(url) => updateField('imageUrl', url)}
                prefix="products"
                className="mt-1"
              />
            </div>
            <div>
              <Label>Galería (opcional)</Label>
              <p className="text-xs text-muted-foreground mt-1 mb-2">
                Imágenes adicionales para el carrusel de la tienda, además de la principal.
              </p>
              <div className="flex flex-wrap gap-3">
                {(form?.images ?? []).map((img, i) => (
                  <div key={i} className="relative">
                    <ImageUploadField
                      value={img}
                      onChange={(url) =>
                        updateField(
                          'images',
                          (form?.images ?? []).map((x, idx) => (idx === i ? url : x))
                        )
                      }
                      prefix="products"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="absolute -top-2 -right-2 h-6 w-6 rounded-full bg-background border border-border"
                      onClick={() =>
                        updateField(
                          'images',
                          (form?.images ?? []).filter((_, idx) => idx !== i)
                        )
                      }
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-2 self-start h-28"
                  onClick={() => updateField('images', [...(form?.images ?? []), ''])}
                >
                  <Plus className="h-3.5 w-3.5" /> Añadir imagen
                </Button>
              </div>
            </div>
            <div>
              <Label>Tallas disponibles</Label>
              <Input
                value={form?.sizes ?? ''}
                onChange={handleChange('sizes')}
                className="mt-1"
                placeholder="S, M, L, XL"
              />
            </div>
            <div>
              <Label>Colores disponibles</Label>
              <Input
                value={form?.colors ?? ''}
                onChange={handleChange('colors')}
                className="mt-1"
                placeholder="Negro, Blanco"
              />
            </div>
            <p className="text-xs text-muted-foreground -mt-2">
              Separa cada opción con una coma. Si lo dejas vacío, el producto se vende sin variantes.
            </p>

            <div className="space-y-2 rounded-md border border-border p-3">
              <Label>Stock por variante</Label>
              <p className="text-xs text-muted-foreground">
                Unidades disponibles. 0 = agotado en esa combinación.
              </p>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {matrixKeys.map((k) => {
                  const key = variantKey(k.size, k.color);
                  const label =
                    [k.size, k.color].filter(Boolean).join(' · ') || 'Única (sin talla/color)';
                  return (
                    <div key={key} className="flex items-center gap-3">
                      <span className="text-sm flex-1 min-w-0 truncate">{label}</span>
                      {stockConflicts[key] !== undefined && (
                        <span className="text-xs text-destructive whitespace-nowrap">Ahora: {stockConflicts[key]}</span>
                      )}
                      <Input
                        type="number"
                        min={0}
                        className="w-24"
                        value={form.stockByKey[key] ?? 0}
                        onChange={(e) => {
                          setStockTouched(true);
                          updateField('stockByKey', {
                            ...form.stockByKey,
                            [key]: Math.max(0, parseInt(e.target.value, 10) || 0),
                          });
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <Label>Visibilidad</Label>
              <Select
                value={form?.isActive ?? 'true'}
                onValueChange={(v: 'true' | 'false') => updateField('isActive', v)}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">Visible en la tienda</SelectItem>
                  <SelectItem value="false">Oculto</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {temporadasDisponibles && (
              <div>
                <Label>Temporada de compras (opcional)</Label>
                <div className="mt-1">
                  <TemporadaSelector
                    temporadas={temporadas}
                    temporadaId={form?.temporadaId ?? null}
                    onChange={(id) => updateField('temporadaId', id)}
                    onTemporadaCreada={(t) => setTemporadas((prev) => [t, ...prev])}
                    allowNone
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Vincula este producto a la temporada de Compras/Gastos{legacy ? ' de la caseta' : ''}, para poder sacar informes de tienda por edición.
                </p>
              </div>
            )}
            <Button onClick={handleSave} disabled={saving} className="w-full gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {editing ? 'Guardar cambios' : 'Crear producto'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
