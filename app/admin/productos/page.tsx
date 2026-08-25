'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import type { Product, ProductVariant } from '@prisma/client';
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
import { ImageUploadField } from '@/app/admin/_components/image-upload-field';
import { expandVariantKeys } from '@/lib/shop-cart';

type ProductWithVariants = Product & { variants?: ProductVariant[] };

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
};

function variantKey(size: string, color: string) {
  return `${size}|${color}`;
}

export default function ProductosPage() {
  const [products, setProducts] = useState<ProductWithVariants[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProductWithVariants | null>(null);
  const [form, setForm] = useState<ProductFormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [stockTouched, setStockTouched] = useState(false);

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
    });
    setStockTouched(false);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!form?.name?.trim()) {
      toast.error('El producto necesita un nombre');
      return;
    }
    setSaving(true);
    try {
      const hadVariants = (editing?.variants ?? []).length > 0;
      const sizesChanged = editing ? (form.sizes ?? '') !== (editing.sizes ?? '') : false;
      const colorsChanged = editing ? (form.colors ?? '') !== (editing.colors ?? '') : false;
      // Solo mandamos `variants` (y por tanto disparamos la sincronización de
      // stock en el servidor) si hay algo real que sincronizar: el producto ya
      // llevaba stock por variante, el admin ha tocado algún número de stock, o
      // ha cambiado las tallas/colores disponibles. Si no, un producto editado
      // sin tocar su stock (p.ej. solo cambiar el precio) no debe quedar
      // "Agotado" por generar filas de stock a 0 que nunca existieron.
      const shouldSyncVariants = !editing || hadVariants || stockTouched || sizesChanged || colorsChanged;
      const variants = matrixKeys.map((k) => ({
        size: k.size || null,
        color: k.color || null,
        stock: form.stockByKey[variantKey(k.size, k.color)] ?? 0,
      }));
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
        ...(shouldSyncVariants ? { variants } : {}),
      };
      const url = editing ? '/api/admin/products/' + editing.id : '/api/admin/products';
      const res = await fetch(url, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
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
