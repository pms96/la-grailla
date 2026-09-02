'use client';

import { useRef, useState } from 'react';
import type { Articulo, PrecioArticulo, Proveedor } from '@prisma/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, ImageUp, Plus, Trash2, Sparkles, Link2 } from 'lucide-react';
import { toast } from 'sonner';
import { CATEGORIAS_ARTICULO } from '@/lib/compras/constantes';

type ArticuloConPrecios = Articulo & { precios: (PrecioArticulo & { proveedor: Proveedor })[] };

const CREAR_NUEVO = '__nuevo__';

type FilaImportada = {
  articuloId: string | null; // null = crear artículo nuevo; si no, se une al ya existente
  nombre: string;
  categoria: string;
  formato: string;
  ivaPercent: string;
  precioSinIva: string;
  descuentoPercent: string;
  formatoVenta: string;
  unidadMinPedido: string;
};

const FILA_VACIA: FilaImportada = {
  articuloId: null,
  nombre: '',
  categoria: CATEGORIAS_ARTICULO[0],
  formato: '',
  ivaPercent: '21',
  precioSinIva: '',
  descuentoPercent: '0',
  formatoVenta: 'Unidad',
  unidadMinPedido: '1',
};

/** Normaliza para comparar nombres sin distinguir mayúsculas, acentos ni espacios extra. */
function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

type Props = {
  open: boolean;
  onClose: () => void;
  proveedores: Proveedor[];
  articulos: ArticuloConPrecios[];
  onImported: () => void;
};

export function ImportarArticulosDialog({ open, onClose, proveedores, articulos, onImported }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [proveedorId, setProveedorId] = useState('');
  const [extrayendo, setExtrayendo] = useState(false);
  const [importando, setImportando] = useState(false);
  const [filas, setFilas] = useState<FilaImportada[]>([]);
  const [analizado, setAnalizado] = useState(false);

  const reset = () => {
    setProveedorId('');
    setFilas([]);
    setAnalizado(false);
  };

  const handleClose = () => {
    if (extrayendo || importando) return;
    reset();
    onClose();
  };

  const handleFileChange = async (file: File) => {
    if (!proveedorId) { toast.error('Elige primero el proveedor'); return; }
    setExtrayendo(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('prefix', 'compras-listados');
      const uploadRes = await fetch('/api/admin/upload', { method: 'POST', body: formData });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) { toast.error(uploadData?.error ?? 'No se pudo subir la imagen'); return; }

      const extraerRes = await fetch('/api/admin/compras/articulos/extraer-imagen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrl: uploadData.url }),
      });
      const extraerData = await extraerRes.json();
      if (!extraerRes.ok) { toast.error(extraerData?.error ?? 'No se pudo analizar la imagen'); return; }

      const items = Array.isArray(extraerData.items) ? extraerData.items : [];
      setFilas(
        items.map((it: { nombre: string; categoria: string; formato: string; formatoVenta: string; precioSinIva: number; unidadMinPedido: number }) => {
          // Auto-vincula si el nombre coincide (ignorando mayúsculas/acentos/espacios) con
          // un artículo ya existente — así dos proveedores con textos de imagen distintos
          // ("Cruzcampo 1/3" vs "Cruzcampo botellín 1/3") se pueden seguir unificando a mano
          // desde el desplegable si esta coincidencia automática no acierta.
          const coincidencia = articulos.find((a) => normalizar(a.nombre) === normalizar(it.nombre));
          if (coincidencia) {
            return {
              articuloId: coincidencia.id,
              nombre: coincidencia.nombre,
              categoria: coincidencia.categoria,
              formato: coincidencia.formato,
              ivaPercent: String(coincidencia.ivaPercent),
              formatoVenta: it.formatoVenta,
              precioSinIva: String(it.precioSinIva ?? ''),
              descuentoPercent: '0',
              unidadMinPedido: String(it.unidadMinPedido ?? 1),
            };
          }
          return {
            articuloId: null,
            nombre: it.nombre,
            categoria: it.categoria,
            formato: it.formato,
            ivaPercent: '21',
            formatoVenta: it.formatoVenta,
            precioSinIva: String(it.precioSinIva ?? ''),
            descuentoPercent: '0',
            unidadMinPedido: String(it.unidadMinPedido ?? 1),
          };
        })
      );
      setAnalizado(true);
      if (items.length === 0) {
        toast.error('No se detectó ningún artículo en la imagen. Puedes añadirlos a mano abajo.');
      } else {
        toast.success(`${items.length} artículo(s) detectado(s) — revísalos antes de importar`);
      }
    } catch {
      toast.error('Error de conexión');
    } finally {
      setExtrayendo(false);
    }
  };

  const updateFila = (idx: number, patch: Partial<FilaImportada>) => {
    setFilas((fs) => fs.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
  };
  const vincularFila = (idx: number, articuloId: string) => {
    if (articuloId === CREAR_NUEVO) {
      updateFila(idx, { articuloId: null });
      return;
    }
    const articulo = articulos.find((a) => a.id === articuloId);
    if (!articulo) return;
    updateFila(idx, {
      articuloId: articulo.id,
      nombre: articulo.nombre,
      categoria: articulo.categoria,
      formato: articulo.formato,
      ivaPercent: String(articulo.ivaPercent),
    });
  };
  const removeFila = (idx: number) => setFilas((fs) => fs.filter((_, i) => i !== idx));
  const addFila = () => setFilas((fs) => [...fs, { ...FILA_VACIA }]);

  const handleImportar = async () => {
    const validas = filas.filter((f) => f.nombre.trim() && f.formato.trim() && f.precioSinIva !== '');
    if (validas.length === 0) { toast.error('Añade al menos un artículo válido (nombre, formato y precio)'); return; }
    setImportando(true);
    try {
      const res = await fetch('/api/admin/compras/articulos/importar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proveedorId,
          items: validas.map((f) => ({
            articuloId: f.articuloId ?? undefined,
            nombre: f.nombre.trim(),
            categoria: f.categoria,
            formato: f.formato.trim(),
            ivaPercent: Number(f.ivaPercent) || 21,
            precioSinIva: Number(f.precioSinIva) || 0,
            descuentoPercent: Number(f.descuentoPercent) || 0,
            formatoVenta: f.formatoVenta.trim() || 'Unidad',
            unidadMinPedido: Number(f.unidadMinPedido) || 1,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data?.error ?? 'No se pudo importar'); return; }
      toast.success(`Importación completa: ${data.creados} nuevo(s), ${data.actualizados} actualizado(s)`);
      reset();
      onImported();
      onClose();
    } catch {
      toast.error('Error de conexión');
    } finally {
      setImportando(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Importar artículos desde imagen</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Proveedor *</Label>
            <Select value={proveedorId} onValueChange={setProveedorId} disabled={analizado}>
              <SelectTrigger className="mt-1"><SelectValue placeholder="Elige el proveedor del listado" /></SelectTrigger>
              <SelectContent>
                {proveedores.map((p) => <SelectItem key={p.id} value={p.id}>{p.nombre}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {!analizado && (
            <div className="rounded-md border border-dashed border-border p-6 text-center space-y-3">
              <ImageUp className="h-8 w-8 mx-auto text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Sube una foto o escaneo del listado de precios de este proveedor. La IA extraerá los artículos automáticamente para que los revises.
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFileChange(f); }}
              />
              <Button
                type="button"
                variant="outline"
                className="gap-2"
                disabled={extrayendo || !proveedorId}
                onClick={() => fileInputRef.current?.click()}
              >
                {extrayendo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {extrayendo ? 'Analizando imagen…' : 'Elegir imagen'}
              </Button>
            </div>
          )}

          {analizado && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Artículos detectados — revisa y corrige antes de importar</Label>
                <Button type="button" variant="outline" size="sm" className="gap-1" onClick={addFila}>
                  <Plus className="h-3.5 w-3.5" /> Añadir fila
                </Button>
              </div>
              <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-1">
                {filas.map((f, idx) => {
                  const vinculada = f.articuloId !== null;
                  return (
                    <div key={idx} className="space-y-2 rounded-md bg-muted/40 p-3">
                      <div className="flex items-start gap-2">
                        <div className="flex-1 space-y-1">
                          <Label className="text-xs text-muted-foreground flex items-center gap-1">
                            <Link2 className="h-3 w-3" /> Vincular a artículo existente (para unificarlo con otros proveedores)
                          </Label>
                          <Select value={f.articuloId ?? CREAR_NUEVO} onValueChange={(v) => vincularFila(idx, v)}>
                            <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value={CREAR_NUEVO}>— Crear artículo nuevo —</SelectItem>
                              {articulos.map((a) => (
                                <SelectItem key={a.id} value={a.id}>{a.nombre} · {a.categoria}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <Button type="button" variant="ghost" size="icon-sm" className="mt-5" onClick={() => removeFila(idx)}>
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        <div className="col-span-2 sm:col-span-1 space-y-1">
                          <Label className="text-xs text-muted-foreground">Nombre</Label>
                          <Input disabled={vinculada} value={f.nombre} onChange={(e) => updateFila(idx, { nombre: e.target.value })} className="h-8" />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs text-muted-foreground">Categoría</Label>
                          <Select value={f.categoria} onValueChange={(v) => updateFila(idx, { categoria: v })} disabled={vinculada}>
                            <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {CATEGORIAS_ARTICULO.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs text-muted-foreground">Formato del producto</Label>
                          <Input disabled={vinculada} placeholder="Lata 33cl" value={f.formato} onChange={(e) => updateFila(idx, { formato: e.target.value })} className="h-8" />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs text-muted-foreground">IVA %</Label>
                          <Input disabled={vinculada} type="number" step="0.1" value={f.ivaPercent} onChange={(e) => updateFila(idx, { ivaPercent: e.target.value })} className="h-8" />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs text-muted-foreground">Formato de venta del proveedor</Label>
                          <Input placeholder="Caja 24 uds" value={f.formatoVenta} onChange={(e) => updateFila(idx, { formatoVenta: e.target.value })} className="h-8" />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs text-muted-foreground">Precio s/IVA (€)</Label>
                          <Input type="number" step="0.01" value={f.precioSinIva} onChange={(e) => updateFila(idx, { precioSinIva: e.target.value })} className="h-8" />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs text-muted-foreground">Descuento del proveedor (%)</Label>
                          <Input type="number" step="0.1" min={0} max={100} value={f.descuentoPercent} onChange={(e) => updateFila(idx, { descuentoPercent: e.target.value })} className="h-8" />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs text-muted-foreground">Unidad mínima de pedido</Label>
                          <Input type="number" min={1} value={f.unidadMinPedido} onChange={(e) => updateFila(idx, { unidadMinPedido: e.target.value })} className="h-8" />
                        </div>
                      </div>
                      {vinculada && (
                        <p className="text-xs text-muted-foreground">
                          Nombre, categoría, formato e IVA vienen del artículo ya existente y no se pueden editar aquí — solo se añade/actualiza el precio de este proveedor.
                        </p>
                      )}
                    </div>
                  );
                })}
                {filas.length === 0 && <p className="text-xs text-muted-foreground">Sin artículos todavía — añade una fila a mano.</p>}
              </div>
              <p className="text-xs text-muted-foreground">
                Las filas marcadas con un artículo ya existente detectado automáticamente se han vinculado por nombre — revisa el resto y vincúlalas a mano si un proveedor distinto usa un nombre diferente para el mismo producto.
              </p>
              <Button onClick={handleImportar} disabled={importando} className="w-full gap-2">
                {importando ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Importar {filas.filter((f) => f.nombre.trim() && f.formato.trim() && f.precioSinIva !== '').length} artículo(s)
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
