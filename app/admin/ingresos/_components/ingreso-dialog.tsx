'use client';

import { useEffect, useState } from 'react';
import type { Ingreso } from '@prisma/client';
import type { WithNumberFields } from '@/lib/prisma';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { CONCEPTOS_INGRESO } from '@/lib/compras/constantes';

type FormState = {
  concepto: string;
  importe: string;
  fecha: string;
  notas: string;
};

const emptyForm = (): FormState => ({
  concepto: CONCEPTOS_INGRESO[0],
  importe: '',
  fecha: new Date().toISOString().slice(0, 10),
  notas: '',
});

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: WithNumberFields<Ingreso, 'importe'> | null;
  temporadaId: string | null;
  onSaved: () => void;
};

export function IngresoDialog({ open, onOpenChange, editing, temporadaId, onSaved }: Props) {
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setForm({
        concepto: editing.concepto,
        importe: String(editing.importe),
        fecha: new Date(editing.fecha).toISOString().slice(0, 10),
        notas: editing.notas ?? '',
      });
    } else {
      setForm(emptyForm());
    }
  }, [open, editing]);

  const handleSave = async () => {
    if (!form.importe || !temporadaId) { toast.error('El ingreso necesita un importe'); return; }
    setSaving(true);
    try {
      const payload = {
        temporadaId,
        concepto: form.concepto,
        importe: Number(form.importe) || 0,
        fecha: form.fecha,
        notas: form.notas || null,
      };
      const url = editing ? `/api/admin/ingresos/${editing.id}` : '/api/admin/ingresos';
      const res = await fetch(url, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) { toast.error('No se pudo guardar el ingreso'); return; }
      toast.success(editing ? 'Ingreso actualizado' : 'Ingreso registrado');
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
        <DialogHeader><DialogTitle>{editing ? 'Editar ingreso' : 'Nuevo ingreso'}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Día</Label>
              <Input type="date" value={form.fecha} onChange={(e) => setForm((f) => ({ ...f, fecha: e.target.value }))} className="mt-1" />
            </div>
            <div>
              <Label>Concepto</Label>
              <Select value={form.concepto} onValueChange={(v) => setForm((f) => ({ ...f, concepto: v }))}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CONCEPTOS_INGRESO.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label>Importe (€) *</Label>
            <Input type="number" step="0.01" value={form.importe} onChange={(e) => setForm((f) => ({ ...f, importe: e.target.value }))} className="mt-1" placeholder="450.00" />
          </div>
          <div>
            <Label>Notas</Label>
            <Textarea value={form.notas} onChange={(e) => setForm((f) => ({ ...f, notas: e.target.value }))} className="mt-1" rows={2} placeholder="Ej. caja del viernes noche" />
          </div>
          <Button onClick={handleSave} disabled={saving} className="w-full gap-2">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {editing ? 'Guardar cambios' : 'Registrar ingreso'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
