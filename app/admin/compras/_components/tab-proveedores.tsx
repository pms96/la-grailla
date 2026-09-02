'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Proveedor } from '@prisma/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Loader2, Plus, Pencil, Trash2, Truck, FileSpreadsheet, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { downloadProveedoresExport } from '@/lib/compras/proveedores-export';

type FormState = { nombre: string; contacto: string; telefono: string; email: string; notas: string };
const EMPTY: FormState = { nombre: '', contacto: '', telefono: '', email: '', notas: '' };

export function TabProveedores() {
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Proveedor | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [exportando, setExportando] = useState<'excel' | 'pdf' | null>(null);

  const fetchProveedores = useCallback(() => {
    fetch('/api/admin/compras/proveedores')
      .then((r) => r.json())
      .then((d) => setProveedores(Array.isArray(d) ? d : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchProveedores(); }, [fetchProveedores]);

  const openCreate = () => { setEditing(null); setForm(EMPTY); setDialogOpen(true); };
  const openEdit = (p: Proveedor) => {
    setEditing(p);
    setForm({ nombre: p.nombre, contacto: p.contacto ?? '', telefono: p.telefono ?? '', email: p.email ?? '', notas: p.notas ?? '' });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!form.nombre.trim()) { toast.error('El proveedor necesita un nombre'); return; }
    setSaving(true);
    try {
      const url = editing ? `/api/admin/compras/proveedores/${editing.id}` : '/api/admin/compras/proveedores';
      const res = await fetch(url, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) { toast.error('No se pudo guardar el proveedor'); return; }
      toast.success(editing ? 'Proveedor actualizado' : 'Proveedor creado');
      setDialogOpen(false);
      fetchProveedores();
    } catch {
      toast.error('Error de conexión');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('¿Desactivar este proveedor?')) return;
    const res = await fetch(`/api/admin/compras/proveedores/${id}`, { method: 'DELETE' });
    if (res.ok) { toast.success('Proveedor desactivado'); fetchProveedores(); } else { toast.error('No se pudo desactivar'); }
  };

  const handleExport = async (format: 'excel' | 'pdf') => {
    setExportando(format);
    try {
      await downloadProveedoresExport(format);
      toast.success(format === 'excel' ? 'Excel de proveedores descargado' : 'PDF de proveedores descargado');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error al exportar');
    } finally {
      setExportando(null);
    }
  };

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" size="sm" className="gap-2" disabled={exportando !== null || proveedores.length === 0} onClick={() => handleExport('excel')}>
          {exportando === 'excel' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
          Exportar Excel
        </Button>
        <Button variant="outline" size="sm" className="gap-2" disabled={exportando !== null || proveedores.length === 0} onClick={() => handleExport('pdf')}>
          {exportando === 'pdf' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
          Exportar PDF
        </Button>
        <Button onClick={openCreate} size="sm" className="gap-2"><Plus className="h-4 w-4" /> Nuevo proveedor</Button>
      </div>

      {proveedores.length === 0 ? (
        <Card><CardContent className="p-10 text-center text-muted-foreground">
          <Truck className="h-8 w-8 mx-auto mb-3 opacity-50" /> Todavía no hay proveedores.
        </CardContent></Card>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {proveedores.map((p) => (
            <Card key={p.id} className={p.activo === false ? 'opacity-60' : ''}>
              <CardContent className="p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold leading-tight">{p.nombre}</p>
                  {p.activo === false && <Badge variant="secondary">Inactivo</Badge>}
                </div>
                <div className="text-xs text-muted-foreground space-y-0.5">
                  {p.contacto && <p>{p.contacto}</p>}
                  {p.telefono && <p>{p.telefono}</p>}
                  {p.email && <p>{p.email}</p>}
                </div>
                <div className="flex gap-2 pt-1">
                  <Button variant="outline" size="sm" className="flex-1 gap-2" onClick={() => openEdit(p)}>
                    <Pencil className="h-3.5 w-3.5" /> Editar
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => handleDelete(p.id)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{editing ? 'Editar proveedor' : 'Nuevo proveedor'}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Nombre *</Label>
              <Input value={form.nombre} onChange={(e) => setForm((f) => ({ ...f, nombre: e.target.value }))} className="mt-1" />
            </div>
            <div>
              <Label>Persona de contacto</Label>
              <Input value={form.contacto} onChange={(e) => setForm((f) => ({ ...f, contacto: e.target.value }))} className="mt-1" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Teléfono</Label>
                <Input value={form.telefono} onChange={(e) => setForm((f) => ({ ...f, telefono: e.target.value }))} className="mt-1" />
              </div>
              <div>
                <Label>Email</Label>
                <Input value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} className="mt-1" />
              </div>
            </div>
            <div>
              <Label>Notas</Label>
              <Textarea value={form.notas} onChange={(e) => setForm((f) => ({ ...f, notas: e.target.value }))} className="mt-1" rows={3} />
            </div>
            <Button onClick={handleSave} disabled={saving} className="w-full gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {editing ? 'Guardar cambios' : 'Crear proveedor'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
