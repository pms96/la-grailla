'use client';

import { useEffect, useState } from 'react';
import type { Gasto, Proveedor } from '@prisma/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { CATEGORIAS_GASTO, TIPOS_DOCUMENTO_GASTO } from '@/lib/compras/constantes';

type FormState = {
  categoria: string;
  concepto: string;
  proveedorId: string;
  importeSinIva: string;
  ivaPercent: string;
  fecha: string;
  numDocumento: string;
  tipoDocumento: string;
  notas: string;
};

const emptyForm = (): FormState => ({
  categoria: CATEGORIAS_GASTO[0],
  concepto: '',
  proveedorId: '',
  importeSinIva: '',
  ivaPercent: '21',
  fecha: new Date().toISOString().slice(0, 10),
  numDocumento: '',
  tipoDocumento: 'Factura',
  notas: '',
});

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: Gasto | null;
  temporadaId: string | null;
  proveedores: Proveedor[];
  onSaved: () => void;
};

export function GastoDialog({ open, onOpenChange, editing, temporadaId, proveedores, onSaved }: Props) {
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setForm({
        categoria: editing.categoria,
        concepto: editing.concepto,
        proveedorId: editing.proveedorId ?? '',
        importeSinIva: String(editing.importeSinIva),
        ivaPercent: String(editing.ivaPercent),
        fecha: new Date(editing.fecha).toISOString().slice(0, 10),
        numDocumento: editing.numDocumento ?? '',
        tipoDocumento: editing.tipoDocumento,
        notas: editing.notas ?? '',
      });
    } else {
      setForm(emptyForm());
    }
  }, [open, editing]);

  const handleSave = async () => {
    if (!form.concepto.trim() || !temporadaId) { toast.error('El gasto necesita un concepto'); return; }
    setSaving(true);
    try {
      const payload = {
        temporadaId,
        categoria: form.categoria,
        concepto: form.concepto.trim(),
        proveedorId: form.proveedorId || null,
        importeSinIva: Number(form.importeSinIva) || 0,
        ivaPercent: Number(form.ivaPercent) || 0,
        fecha: form.fecha,
        numDocumento: form.numDocumento || null,
        tipoDocumento: form.tipoDocumento,
        notas: form.notas || null,
      };
      const url = editing ? `/api/admin/gastos/${editing.id}` : '/api/admin/gastos';
      const res = await fetch(url, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) { toast.error('No se pudo guardar el gasto'); return; }
      toast.success(editing ? 'Gasto actualizado' : 'Gasto registrado');
      onOpenChange(false);
      onSaved();
    } catch {
      toast.error('Error de conexión');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{editing ? 'Editar gasto' : 'Nuevo gasto'}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Concepto *</Label>
            <Input value={form.concepto} onChange={(e) => setForm((f) => ({ ...f, concepto: e.target.value }))} className="mt-1" placeholder="Alquiler del puesto" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Categoría</Label>
              <Select value={form.categoria} onValueChange={(v) => setForm((f) => ({ ...f, categoria: v }))}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORIAS_GASTO.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Tipo de documento</Label>
              <Select value={form.tipoDocumento} onValueChange={(v) => setForm((f) => ({ ...f, tipoDocumento: v }))}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TIPOS_DOCUMENTO_GASTO.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label>Proveedor (opcional)</Label>
            <Select value={form.proveedorId || '__none__'} onValueChange={(v) => setForm((f) => ({ ...f, proveedorId: v === '__none__' ? '' : v }))}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Sin proveedor</SelectItem>
                {proveedores.map((p) => <SelectItem key={p.id} value={p.id}>{p.nombre}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Importe s/IVA (€) *</Label>
              <Input type="number" step="0.01" value={form.importeSinIva} onChange={(e) => setForm((f) => ({ ...f, importeSinIva: e.target.value }))} className="mt-1" />
              <p className="text-xs text-muted-foreground mt-1">Negativo para abonos/devoluciones.</p>
            </div>
            <div>
              <Label>IVA (%)</Label>
              <Input type="number" value={form.ivaPercent} onChange={(e) => setForm((f) => ({ ...f, ivaPercent: e.target.value }))} className="mt-1" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Fecha</Label>
              <Input type="date" value={form.fecha} onChange={(e) => setForm((f) => ({ ...f, fecha: e.target.value }))} className="mt-1" />
            </div>
            <div>
              <Label>Nº documento</Label>
              <Input value={form.numDocumento} onChange={(e) => setForm((f) => ({ ...f, numDocumento: e.target.value }))} className="mt-1" />
            </div>
          </div>
          <div>
            <Label>Notas</Label>
            <Textarea value={form.notas} onChange={(e) => setForm((f) => ({ ...f, notas: e.target.value }))} className="mt-1" rows={2} />
          </div>
          <Button onClick={handleSave} disabled={saving} className="w-full gap-2">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {editing ? 'Guardar cambios' : 'Registrar gasto'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
