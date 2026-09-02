'use client';

import { useRef, useState } from 'react';
import type { Proveedor } from '@prisma/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, ImageUp, Plus, Trash2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { CATEGORIAS_ARTICULO } from '@/lib/compras/constantes';

type FilaImportada = {
  nombre: string;
  categoria: string;
  formato: string;
  precioSinIva: string;
  formatoVenta: string;
  unidadMinPedido: string;
};

const FILA_VACIA: FilaImportada = {
  nombre: '',
  categoria: CATEGORIAS_ARTICULO[0],
  formato: '',
  precioSinIva: '',
  formatoVenta: 'Unidad',
  unidadMinPedido: '1',
};

type Props = {
  open: boolean;
  onClose: () => void;
  proveedores: Proveedor[];
  onImported: () => void;
};

export function ImportarArticulosDialog({ open, onClose, proveedores, onImported }: Props) {
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
        items.map((it: { nombre: string; categoria: string; formato: string; formatoVenta: string; precioSinIva: number; unidadMinPedido: number }) => ({
          nombre: it.nombre,
          categoria: it.categoria,
          formato: it.formato,
          formatoVenta: it.formatoVenta,
          precioSinIva: String(it.precioSinIva ?? ''),
          unidadMinPedido: String(it.unidadMinPedido ?? 1),
        }))
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
            nombre: f.nombre.trim(),
            categoria: f.categoria,
            formato: f.formato.trim(),
            precioSinIva: Number(f.precioSinIva) || 0,
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
              <div className="space-y-2 max-h-[45vh] overflow-y-auto pr-1">
                {filas.map((f, idx) => (
                  <div key={idx} className="grid grid-cols-[1fr_auto] gap-2 rounded-md bg-muted/40 p-2">
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      <Input placeholder="Nombre" value={f.nombre} onChange={(e) => updateFila(idx, { nombre: e.target.value })} className="h-8 col-span-2 sm:col-span-1" />
                      <Select value={f.categoria} onValueChange={(v) => updateFila(idx, { categoria: v })}>
                        <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {CATEGORIAS_ARTICULO.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Input placeholder="Formato" value={f.formato} onChange={(e) => updateFila(idx, { formato: e.target.value })} className="h-8" />
                      <Input placeholder="Formato de venta" value={f.formatoVenta} onChange={(e) => updateFila(idx, { formatoVenta: e.target.value })} className="h-8" />
                      <Input type="number" step="0.01" placeholder="Precio s/IVA" value={f.precioSinIva} onChange={(e) => updateFila(idx, { precioSinIva: e.target.value })} className="h-8" />
                      <Input type="number" min={1} placeholder="Ud. mín. pedido" value={f.unidadMinPedido} onChange={(e) => updateFila(idx, { unidadMinPedido: e.target.value })} className="h-8" />
                    </div>
                    <Button type="button" variant="ghost" size="icon-sm" onClick={() => removeFila(idx)}>
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                ))}
                {filas.length === 0 && <p className="text-xs text-muted-foreground">Sin artículos todavía — añade una fila a mano.</p>}
              </div>
              <p className="text-xs text-muted-foreground">
                Un artículo con el mismo nombre que uno ya existente se actualizará con el precio de este proveedor; si no existe, se creará nuevo.
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
