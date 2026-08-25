'use client';

import { useEffect, useState } from 'react';
import type { Event, TicketType } from '@prisma/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Plus, Pencil, Trash2, Loader2, Ticket } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layouts/page-header';

type EventWithTicketTypes = Event & { ticketTypes: TicketType[] };

type TicketTypeFormState = {
  name: string;
  description: string;
  price: number;
  phase: number;
  phaseName: string;
  maxQuantity: number;
  sortOrder: number;
  isActive: boolean;
};

export default function EntradasPage() {
  const [events, setEvents] = useState<EventWithTicketTypes[]>([]);
  const [selectedEvent, setSelectedEvent] = useState('');
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TicketType | null>(null);
  const [form, setForm] = useState<Partial<TicketTypeFormState>>({});
  const [saving, setSaving] = useState(false);

  const fetchEvents = () => {
    fetch('/api/admin/events')
      .then((r) => r.json())
      .then((d) => {
        setEvents(d ?? []);
        if (!selectedEvent && d?.[0]?.id) setSelectedEvent(d[0].id);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchEvents(); }, []);

  const currentEvent = events?.find((e) => e?.id === selectedEvent);
  const ticketTypes = currentEvent?.ticketTypes ?? [];

  const openCreate = () => {
    setEditing(null);
    setForm({ name: '', description: '', price: 0, phase: 1, phaseName: 'General', maxQuantity: 100, sortOrder: 0, isActive: true });
    setDialogOpen(true);
  };

  const openEdit = (tt: TicketType) => {
    setEditing(tt);
    setForm({ name: tt?.name ?? '', description: tt?.description ?? '', price: tt?.price ?? 0, phase: tt?.phase ?? 1, phaseName: tt?.phaseName ?? '', maxQuantity: tt?.maxQuantity ?? 100, sortOrder: tt?.sortOrder ?? 0, isActive: tt?.isActive ?? true });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const url = editing ? `/api/admin/ticket-types/${editing.id}` : '/api/admin/ticket-types';
      const method = editing ? 'PUT' : 'POST';
      const payload = editing ? form : { ...form, eventId: selectedEvent };
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await res.json();
      if (data?.error) toast.error(data.error);
      else { toast.success(editing ? 'Actualizado' : 'Creado'); setDialogOpen(false); fetchEvents(); }
    } catch { toast.error('Error'); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('¿Eliminar este tipo de entrada?')) return;
    const res = await fetch(`/api/admin/ticket-types/${id}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast.error(data?.error ?? 'No se pudo eliminar'); return; }
    toast.success('Eliminado');
    fetchEvents();
  };

  const updateField = <K extends keyof TicketTypeFormState>(key: K, value: TicketTypeFormState[K]) =>
    setForm((prev) => ({ ...(prev ?? {}), [key]: value }));

  const handleChange = (key: 'name' | 'description' | 'phaseName') => (e: React.ChangeEvent<HTMLInputElement>) =>
    updateField(key, e?.target?.value ?? '');

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-6">
      <PageHeader title="Entradas" description="Gestiona tipos de entrada, fases y precios" />

      <div className="flex items-center gap-4">
        <Select value={selectedEvent} onValueChange={setSelectedEvent}>
          <SelectTrigger className="max-w-xs"><SelectValue placeholder="Selecciona evento" /></SelectTrigger>
          <SelectContent>
            {(events ?? []).map((e) => <SelectItem key={e?.id} value={e?.id ?? ''}>{e?.name ?? ''}</SelectItem>)}
          </SelectContent>
        </Select>

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button onClick={openCreate} className="gap-2" disabled={!selectedEvent}><Plus className="h-4 w-4" /> Nuevo Tipo</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>{editing ? 'Editar Tipo de Entrada' : 'Nuevo Tipo de Entrada'}</DialogTitle></DialogHeader>
            <div className="space-y-4 mt-4">
              <div><Label>Nombre</Label><Input value={form?.name ?? ''} onChange={handleChange('name')} className="mt-1" /></div>
              <div><Label>Descripción</Label><Input value={form?.description ?? ''} onChange={handleChange('description')} className="mt-1" /></div>
              <div className="grid grid-cols-2 gap-4">
                <div><Label>Precio (€)</Label><Input type="number" step="0.01" min="0" value={form?.price ?? 0} onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateField('price', Math.max(0, parseFloat(e?.target?.value) || 0))} className="mt-1" /></div>
                <div><Label>Stock máximo</Label><Input type="number" min="0" value={form?.maxQuantity ?? 100} onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateField('maxQuantity', Math.max(0, parseInt(e?.target?.value) || 100))} className="mt-1" /></div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div><Label>Fase</Label><Input type="number" value={form?.phase ?? 1} onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateField('phase', parseInt(e?.target?.value) || 1)} className="mt-1" /></div>
                <div><Label>Nombre de fase</Label><Input value={form?.phaseName ?? ''} onChange={handleChange('phaseName')} className="mt-1" /></div>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={form?.isActive ?? true} onCheckedChange={(v: boolean) => updateField('isActive', v)} />
                <Label>Activa</Label>
              </div>
              <Button onClick={handleSave} disabled={saving} className="w-full">
                {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                {editing ? 'Guardar' : 'Crear'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="space-y-3">
        {ticketTypes.map((tt) => (
          <Card key={tt?.id}>
            <CardContent className="p-4 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <Ticket className="h-5 w-5 text-primary" />
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{tt?.name ?? ''}</p>
                    <Badge variant="outline" className="text-xs">{tt?.phaseName ?? ''}</Badge>
                    {!tt?.isActive && <Badge variant="secondary" className="text-xs">Inactiva</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground">{tt?.soldCount ?? 0}/{tt?.maxQuantity ?? 0} vendidas · {(tt?.price ?? 0).toFixed(2)}€</p>
                </div>
              </div>
              <div className="flex gap-1">
                <Button variant="ghost" size="icon-sm" onClick={() => openEdit(tt)}><Pencil className="h-3.5 w-3.5" /></Button>
                <Button variant="ghost" size="icon-sm" onClick={() => handleDelete(tt?.id)}><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button>
              </div>
            </CardContent>
          </Card>
        ))}
        {ticketTypes.length === 0 && selectedEvent && (
          <p className="text-center py-8 text-muted-foreground">No hay tipos de entrada para este evento</p>
        )}
      </div>
    </div>
  );
}
