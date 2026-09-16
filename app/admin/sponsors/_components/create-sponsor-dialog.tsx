'use client';

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, CheckCircle } from 'lucide-react';
import { toast } from 'sonner';
import { DEFAULT_SPONSOR_TIERS, type SponsorTier } from '@/lib/sponsor-tiers';
import { SponsorInviteDelivery } from './sponsor-invite-delivery';

type FormState = {
  companyName: string;
  contactName: string;
  email: string;
  phone: string;
  website: string;
  sponsorType: string;
  message: string;
  status: 'PENDING' | 'CONTACTED' | 'ACCEPTED';
};

const emptyForm = (): FormState => ({
  companyName: '',
  contactName: '',
  email: '',
  phone: '',
  website: '',
  sponsorType: '',
  message: '',
  status: 'ACCEPTED',
});

type CreateResult = {
  portalUrl: string | null;
  invitationEmailSuccess: boolean | null;
  contactName: string;
  phone: string | null;
};

type Props = { open: boolean; onOpenChange: (open: boolean) => void; onCreated: () => void };

// Alta manual de sponsor — para acuerdos cerrados por teléfono/WhatsApp/en
// persona, sin pasar por el formulario público. Al crear con status ACCEPTED,
// el backend ya genera el portal y envía la invitación (reutilizando
// ensureSponsorPortalInvite); aquí solo mostramos el resultado.
export function CreateSponsorDialog({ open, onOpenChange, onCreated }: Props) {
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<CreateResult | null>(null);
  const [tiers, setTiers] = useState<SponsorTier[]>(DEFAULT_SPONSOR_TIERS);

  useEffect(() => {
    fetch('/api/sponsors/tiers')
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d?.tiers) && d.tiers.length > 0) setTiers(d.tiers); })
      .catch(() => {});
  }, []);

  const close = (openState: boolean) => {
    if (!openState) {
      setForm(emptyForm());
      setResult(null);
    }
    onOpenChange(openState);
  };

  const handleSave = async () => {
    if (!form.companyName.trim() || !form.contactName.trim() || !form.email.trim() || !form.sponsorType) {
      toast.error('Completa los campos obligatorios');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/admin/sponsors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'No se pudo crear el sponsor');
      toast.success('Sponsor creado');
      onCreated();
      if (data?.portalUrl) {
        setResult({
          portalUrl: data.portalUrl,
          invitationEmailSuccess: data.invitationEmailSuccess,
          contactName: form.contactName,
          phone: form.phone || null,
        });
      } else {
        close(false);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error al crear el sponsor');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{result ? 'Sponsor creado' : 'Añadir sponsor'}</DialogTitle></DialogHeader>

        {result ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm text-lima">
              <CheckCircle className="h-4 w-4" />
              El portal ya está listo — entrégaselo por cualquiera de estas vías.
            </div>
            <SponsorInviteDelivery
              portalUrl={result.portalUrl!}
              contactName={result.contactName}
              phone={result.phone}
              emailStatus={result.invitationEmailSuccess === false ? 'FAILED' : result.invitationEmailSuccess === true ? 'SENT' : null}
            />
            <Button variant="outline" className="w-full" onClick={() => close(false)}>Cerrar</Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Empresa *</Label>
                <Input value={form.companyName} onChange={(e) => setForm((f) => ({ ...f, companyName: e.target.value }))} className="mt-1" placeholder="Empresa S.L." />
              </div>
              <div>
                <Label>Contacto *</Label>
                <Input value={form.contactName} onChange={(e) => setForm((f) => ({ ...f, contactName: e.target.value }))} className="mt-1" placeholder="Juan Pérez" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Email *</Label>
                <Input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} className="mt-1" placeholder="contacto@empresa.com" />
              </div>
              <div>
                <Label>Teléfono</Label>
                <Input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} className="mt-1" placeholder="+34 600 000 000" />
              </div>
            </div>
            <div>
              <Label>Web o Instagram</Label>
              <Input value={form.website} onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))} className="mt-1" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Tipo de patrocinio *</Label>
                <Select value={form.sponsorType} onValueChange={(v) => setForm((f) => ({ ...f, sponsorType: v }))}>
                  <SelectTrigger className="mt-1"><SelectValue placeholder="Selecciona" /></SelectTrigger>
                  <SelectContent>
                    {tiers.map((tier) => (
                      <SelectItem key={tier.value} value={tier.value}>{tier.label} — {tier.priceLabel}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Estado inicial</Label>
                <Select value={form.status} onValueChange={(v: FormState['status']) => setForm((f) => ({ ...f, status: v }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ACCEPTED">Aceptado — genera portal ya</SelectItem>
                    <SelectItem value="CONTACTED">En contacto</SelectItem>
                    <SelectItem value="PENDING">Pendiente</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Mensaje / notas</Label>
              <Textarea value={form.message} onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))} className="mt-1" rows={2} />
            </div>
            <Button onClick={handleSave} disabled={saving} className="w-full gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Crear sponsor
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
