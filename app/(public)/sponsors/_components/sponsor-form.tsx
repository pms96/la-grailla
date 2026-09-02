'use client';

import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CheckCircle, Loader2, Send } from 'lucide-react';
import { toast } from 'sonner';

export default function SponsorForm() {
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    companyName: '',
    contactName: '',
    email: '',
    phone: '',
    website: '',
    sponsorType: '',
    message: '',
  });

  const updateField = (key: keyof typeof form, value: string) => {
    setForm((prev) => ({ ...(prev ?? {}), [key]: value }));
  };

  const handleChange = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    updateField(key, e?.target?.value ?? '');

  const handleSubmit = async () => {
    if (!form?.companyName?.trim() || !form?.contactName?.trim() || !form?.email?.trim() || !form?.sponsorType) {
      toast.error('Completa los campos obligatorios');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/sponsors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (data?.success) {
        setSent(true);
        toast.success('Solicitud enviada correctamente');
      } else {
        toast.error(data?.error ?? 'Error al enviar');
      }
    } catch {
      toast.error('Error de conexión');
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <Card>
        <CardContent className="p-8 text-center">
          <CheckCircle className="h-12 w-12 text-green-500 mx-auto mb-4" />
          <h3 className="font-display font-bold text-xl mb-2">Solicitud Enviada</h3>
          <p className="text-muted-foreground">Nos pondremos en contacto contigo pronto. ¡Gracias!</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-6 space-y-4">
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <Label>Nombre de la empresa *</Label>
            <Input value={form?.companyName ?? ''} onChange={handleChange('companyName')} className="mt-1" placeholder="Empresa S.L." />
          </div>
          <div>
            <Label>Persona de contacto *</Label>
            <Input value={form?.contactName ?? ''} onChange={handleChange('contactName')} className="mt-1" placeholder="Juan Pérez" />
          </div>
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <Label>Email *</Label>
            <Input type="email" value={form?.email ?? ''} onChange={handleChange('email')} className="mt-1" placeholder="contacto@empresa.com" />
          </div>
          <div>
            <Label>Teléfono</Label>
            <Input value={form?.phone ?? ''} onChange={handleChange('phone')} className="mt-1" placeholder="+34 600 000 000" />
          </div>
        </div>
        <div>
          <Label>Web o Instagram</Label>
          <Input
            value={form?.website ?? ''}
            onChange={handleChange('website')}
            className="mt-1"
            placeholder="https://tuempresa.com o instagram.com/tuempresa"
          />
          <p className="text-xs text-muted-foreground mt-1">Nos ayuda a conocer tu marca para adaptar mejor el material que preparemos.</p>
        </div>
        <div>
          <Label>Tipo de patrocinio *</Label>
          <Select value={form?.sponsorType ?? ''} onValueChange={(v: string) => updateField('sponsorType', v)}>
            <SelectTrigger className="mt-1"><SelectValue placeholder="Selecciona una opción" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="evento">Patrocinio de evento</SelectItem>
              <SelectItem value="espacio">Espacio físico / Stand</SelectItem>
              <SelectItem value="ambos">Ambos</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Mensaje</Label>
          <Textarea value={form?.message ?? ''} onChange={handleChange('message')} className="mt-1" placeholder="Cuéntanos más sobre tu propuesta..." rows={4} />
        </div>
        <Button onClick={handleSubmit} disabled={loading} className="gap-2">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {loading ? 'Enviando...' : 'Enviar Solicitud'}
        </Button>
      </CardContent>
    </Card>
  );
}
