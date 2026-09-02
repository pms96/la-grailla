'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Articulo, PrecioArticulo, Proveedor } from '@prisma/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Plus, Pencil, Trash2, Package, X } from 'lucide-react';
import { toast } from 'sonner';
import { CATEGORIAS_ARTICULO } from '@/lib/compras/constantes';
import { precioConIva } from '@/lib/compras/calculadora';

type ArticuloConPrecios = Articulo & { precios: (PrecioArticulo & { proveedor: Proveedor })[] };

type PrecioForm = { proveedorId: string; precioSinIva: string; formatoVenta: string; unidadMinPedido: string };

type FormState = {
  nombre: string;
  categoria: string;
  formato: string;
  unidadesPorCaja: string;
  ivaPercent: string;
  precios: PrecioForm[];
};

const EMPTY: FormState = {
  nombre: '',
  categoria: CATEGORIAS_ARTICULO[0],
  formato: '',
  unidadesPorCaja: '1',
  ivaPercent: '21',
  precios: [],
};

export function TabArticulos() {
  const [articulos, setArticulos] = useState<ArticuloConPrecios[]>([]);
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ArticuloConPrecios | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);

  const fetchAll = useCallback(() => {
    Promise.all([
      fetch('/api/admin/compras/articulos').then((r) => r.json()),
      fetch('/api/admin/compras/proveedores').then((r) => r.json()),
    ])
      .then(([a, p]) => {
        setArticulos(Array.isArray(a) ? a : []);
        setProveedores(Array.isArray(p) ? p.filter((x: Proveedor) => x.activo) : []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const openCreate = () => { setEditing(null); setForm(EMPTY); setDialogOpen(true); };
  const openEdit = (a: ArticuloConPrecios) => {
    setEditing(a);
    setForm({
      nombre: a.nombre,
      categoria: a.categoria,
      formato: a.formato,
      unidadesPorCaja: String(a.unidadesPorCaja),
      ivaPercent: String(a.ivaPercent),
      precios: a.precios.map((p) => ({
        proveedorId: p.proveedorId,
        precioSinIva: String(p.precioSinIva),
        formatoVenta: p.formatoVenta,
        unidadMinPedido: String(p.unidadMinPedido),
      })),
    });
    setDialogOpen(true);
  };

  const addPrecioRow = () => {
    const usados = new Set(form.precios.map((p) => p.proveedorId));
    const siguiente = proveedores.find((p) => !usados.has(p.id));
    if (!siguiente) { toast.error('Ya hay un precio para todos los proveedores activos'); return; }
    setForm((f) => ({ ...f, precios: [...f.precios, { proveedorId: siguiente.id, precioSinIva: '', formatoVenta: '', unidadMinPedido: '1' }] }));
  };
  const updatePrecioRow = (idx: number, patch: Partial<PrecioForm>) => {
    setForm((f) => ({ ...f, precios: f.precios.map((p, i) => (i === idx ? { ...p, ...patch } : p)) }));
  };
  const removePrecioRow = (idx: number) => {
    setForm((f) => ({ ...f, precios: f.precios.filter((_, i) => i !== idx) }));
  };

  const handleSave = async () => {
    if (!form.nombre.trim() || !form.formato.trim()) { toast.error('Nombre y formato son obligatorios'); return; }
    setSaving(true);
    try {
      const payload = {
        nombre: form.nombre.trim(),
        categoria: form.categoria,
        formato: form.formato.trim(),
        unidadesPorCaja: Number(form.unidadesPorCaja) || 1,
        ivaPercent: Number(form.ivaPercent) || 21,
        precios: form.precios
          .filter((p) => p.proveedorId && p.precioSinIva !== '')
          .map((p) => ({
            proveedorId: p.proveedorId,
            precioSinIva: Number(p.precioSinIva) || 0,
            formatoVenta: p.formatoVenta.trim() || 'Unidad',
            unidadMinPedido: Number(p.unidadMinPedido) || 1,
          })),
      };
      const url = editing ? `/api/admin/compras/articulos/${editing.id}` : '/api/admin/compras/articulos';
      const res = await fetch(url, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) { toast.error('No se pudo guardar el artículo'); return; }
      toast.success(editing ? 'Artículo actualizado' : 'Artículo creado');
      setDialogOpen(false);
      fetchAll();
    } catch {
      toast.error('Error de conexión');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('¿Desactivar este artículo?')) return;
    const res = await fetch(`/api/admin/compras/articulos/${id}`, { method: 'DELETE' });
    if (res.ok) { toast.success('Artículo desactivado'); fetchAll(); } else { toast.error('No se pudo desactivar'); }
  };

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={openCreate} size="sm" className="gap-2" disabled={proveedores.length === 0}>
          <Plus className="h-4 w-4" /> Nuevo artículo
        </Button>
      </div>
      {proveedores.length === 0 && (
        <p className="text-sm text-muted-foreground">Crea al menos un proveedor en la pestaña Proveedores antes de dar de alta artículos.</p>
      )}

      {articulos.length === 0 ? (
        <Card><CardContent className="p-10 text-center text-muted-foreground">
          <Package className="h-8 w-8 mx-auto mb-3 opacity-50" /> Todavía no hay artículos.
        </CardContent></Card>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {articulos.map((a) => {
            const mejor = a.precios.reduce<typeof a.precios[number] | null>((min, p) => {
              const c = precioConIva(p.precioSinIva, a.ivaPercent);
              const cMin = min ? precioConIva(min.precioSinIva, a.ivaPercent) : Infinity;
              return c < cMin ? p : min;
            }, null);
            return (
              <Card key={a.id} className={a.activo === false ? 'opacity-60' : ''}>
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-semibold leading-tight">{a.nombre}</p>
                    {a.activo === false && <Badge variant="secondary">Inactivo</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground">{a.categoria} · {a.formato}</p>
                  <div className="flex flex-wrap gap-1">
                    {a.precios.length === 0 && <Badge variant="destructive">Sin precios</Badge>}
                    {a.precios.map((p) => (
                      <Badge key={p.id} variant={p.id === mejor?.id ? 'default' : 'outline'}>
                        {p.proveedor.nombre}: {precioConIva(p.precioSinIva, a.ivaPercent).toFixed(2)}€
                      </Badge>
                    ))}
                  </div>
                  <div className="flex gap-2 pt-1">
                    <Button variant="outline" size="sm" className="flex-1 gap-2" onClick={() => openEdit(a)}>
                      <Pencil className="h-3.5 w-3.5" /> Editar
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => handleDelete(a.id)}>
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
          <DialogHeader><DialogTitle>{editing ? 'Editar artículo' : 'Nuevo artículo'}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Nombre *</Label>
              <Input value={form.nombre} onChange={(e) => setForm((f) => ({ ...f, nombre: e.target.value }))} className="mt-1" placeholder="Coca Cola 33cl" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Categoría</Label>
                <Select value={form.categoria} onValueChange={(v) => setForm((f) => ({ ...f, categoria: v }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CATEGORIAS_ARTICULO.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Formato *</Label>
                <Input value={form.formato} onChange={(e) => setForm((f) => ({ ...f, formato: e.target.value }))} className="mt-1" placeholder="Lata 33cl" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Unidades por caja</Label>
                <Input type="number" min={1} value={form.unidadesPorCaja} onChange={(e) => setForm((f) => ({ ...f, unidadesPorCaja: e.target.value }))} className="mt-1" />
              </div>
              <div>
                <Label>IVA (%)</Label>
                <Input type="number" value={form.ivaPercent} onChange={(e) => setForm((f) => ({ ...f, ivaPercent: e.target.value }))} className="mt-1" />
              </div>
            </div>

            <div className="space-y-2 rounded-md border border-border p-3">
              <div className="flex items-center justify-between">
                <Label>Precios por proveedor</Label>
                <Button type="button" variant="outline" size="sm" className="gap-1" onClick={addPrecioRow}>
                  <Plus className="h-3.5 w-3.5" /> Añadir
                </Button>
              </div>
              {form.precios.length === 0 && <p className="text-xs text-muted-foreground">Sin precios todavía.</p>}
              <div className="space-y-3">
                {form.precios.map((p, idx) => (
                  <div key={idx} className="flex items-start gap-2 rounded-md bg-muted/40 p-2">
                    <div className="flex-1 space-y-2">
                      <Select value={p.proveedorId} onValueChange={(v) => updatePrecioRow(idx, { proveedorId: v })}>
                        <SelectTrigger className="h-8"><SelectValue placeholder="Proveedor" /></SelectTrigger>
                        <SelectContent>
                          {proveedores.map((prov) => <SelectItem key={prov.id} value={prov.id}>{prov.nombre}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <div className="grid grid-cols-3 gap-2">
                        <Input
                          type="number" step="0.01" placeholder="Precio s/IVA"
                          value={p.precioSinIva} onChange={(e) => updatePrecioRow(idx, { precioSinIva: e.target.value })} className="h-8"
                        />
                        <Input
                          placeholder="Formato venta" value={p.formatoVenta}
                          onChange={(e) => updatePrecioRow(idx, { formatoVenta: e.target.value })} className="h-8 col-span-2"
                        />
                      </div>
                      <Input
                        type="number" min={1} placeholder="Unidad mínima de pedido"
                        value={p.unidadMinPedido} onChange={(e) => updatePrecioRow(idx, { unidadMinPedido: e.target.value })} className="h-8"
                      />
                    </div>
                    <Button type="button" variant="ghost" size="icon-sm" onClick={() => removePrecioRow(idx)}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>

            <Button onClick={handleSave} disabled={saving} className="w-full gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {editing ? 'Guardar cambios' : 'Crear artículo'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
