'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CheckCircle, Loader2, Send } from 'lucide-react';
import { toast } from 'sonner';
import { SPONSOR_TIERS } from '@/lib/sponsor-tiers';

type FormState = {
  companyName: string;
  contactName: string;
  email: string;
  phone: string;
  website: string;
  sponsorType: string;
  message: string;
};

type FieldErrors = Partial<Record<keyof FormState, string>>;

function validateField(key: keyof FormState, value: string): string | undefined {
  switch (key) {
    case 'companyName':
      return value.trim() ? undefined : 'Indica el nombre de la empresa';
    case 'contactName':
      return value.trim() ? undefined : 'Indica una persona de contacto';
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? undefined : 'Introduce un email válido';
    case 'sponsorType':
      return value ? undefined : 'Elige un tipo de patrocinio';
    default:
      return undefined;
  }
}

export default function SponsorForm() {
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState<FormState>({
    companyName: '',
    contactName: '',
    email: '',
    phone: '',
    website: '',
    sponsorType: '',
    message: '',
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [touched, setTouched] = useState<Partial<Record<keyof FormState, boolean>>>({});
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [consentTouched, setConsentTouched] = useState(false);

  const updateField = (key: keyof FormState, value: string) => {
    setForm((prev) => ({ ...(prev ?? {}), [key]: value }));
    if (touched[key]) {
      setErrors((prev) => ({ ...prev, [key]: validateField(key, value) }));
    }
  };

  const handleBlur = (key: keyof FormState) => () => {
    setTouched((prev) => ({ ...prev, [key]: true }));
    setErrors((prev) => ({ ...prev, [key]: validateField(key, form[key]) }));
  };

  const handleChange = (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    updateField(key, e?.target?.value ?? '');

  const handleSubmit = async () => {
    const fieldErrors: FieldErrors = {};
    (Object.keys(form) as (keyof FormState)[]).forEach((key) => {
      const error = validateField(key, form[key]);
      if (error) fieldErrors[key] = error;
    });
    setErrors(fieldErrors);
    setTouched({ companyName: true, contactName: true, email: true, phone: true, website: true, sponsorType: true, message: true });
    setConsentTouched(true);

    if (Object.keys(fieldErrors).length > 0) {
      toast.error('Revisa los campos marcados en rojo');
      return;
    }
    if (!consentAccepted) {
      toast.error('Debes aceptar la política de privacidad para continuar');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/sponsors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, consentAccepted: true }),
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
          <p className="text-muted-foreground">
            Nos pondremos en contacto contigo en un plazo de 2-3 días laborables. Si aceptamos tu
            solicitud, recibirás un email con acceso a tu portal privado de patrocinador.
          </p>
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
            <Input
              value={form.companyName}
              onChange={handleChange('companyName')}
              onBlur={handleBlur('companyName')}
              className="mt-1"
              placeholder="Empresa S.L."
              aria-invalid={Boolean(errors.companyName)}
            />
            {errors.companyName && <p className="text-xs text-destructive mt-1">{errors.companyName}</p>}
          </div>
          <div>
            <Label>Persona de contacto *</Label>
            <Input
              value={form.contactName}
              onChange={handleChange('contactName')}
              onBlur={handleBlur('contactName')}
              className="mt-1"
              placeholder="Juan Pérez"
              aria-invalid={Boolean(errors.contactName)}
            />
            {errors.contactName && <p className="text-xs text-destructive mt-1">{errors.contactName}</p>}
          </div>
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <Label>Email *</Label>
            <Input
              type="email"
              value={form.email}
              onChange={handleChange('email')}
              onBlur={handleBlur('email')}
              className="mt-1"
              placeholder="contacto@empresa.com"
              aria-invalid={Boolean(errors.email)}
            />
            {errors.email && <p className="text-xs text-destructive mt-1">{errors.email}</p>}
          </div>
          <div>
            <Label>Teléfono</Label>
            <Input value={form.phone} onChange={handleChange('phone')} className="mt-1" placeholder="+34 600 000 000" />
          </div>
        </div>
        <div>
          <Label>Web o Instagram</Label>
          <Input
            value={form.website}
            onChange={handleChange('website')}
            className="mt-1"
            placeholder="https://tuempresa.com o instagram.com/tuempresa"
          />
          <p className="text-xs text-muted-foreground mt-1">Nos ayuda a conocer tu marca para adaptar mejor el material que preparemos.</p>
        </div>
        <div>
          <Label>Tipo de patrocinio *</Label>
          <Select value={form.sponsorType} onValueChange={(v: string) => { updateField('sponsorType', v); setTouched((p) => ({ ...p, sponsorType: true })); }}>
            <SelectTrigger className="mt-1" aria-invalid={Boolean(errors.sponsorType)}><SelectValue placeholder="Selecciona una opción" /></SelectTrigger>
            <SelectContent>
              {SPONSOR_TIERS.map((tier) => (
                <SelectItem key={tier.value} value={tier.value}>{tier.label} — {tier.priceLabel}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {errors.sponsorType && <p className="text-xs text-destructive mt-1">{errors.sponsorType}</p>}
        </div>
        <div>
          <Label>Mensaje</Label>
          <Textarea value={form.message} onChange={handleChange('message')} className="mt-1" placeholder="Cuéntanos más sobre tu propuesta..." rows={4} />
        </div>
        <div className="flex items-start gap-2 pt-1">
          <Checkbox
            id="sponsor-consent"
            checked={consentAccepted}
            onCheckedChange={(v) => { setConsentAccepted(v === true); setConsentTouched(true); }}
            className="mt-0.5"
            aria-invalid={consentTouched && !consentAccepted}
          />
          <Label htmlFor="sponsor-consent" className="text-xs font-normal text-muted-foreground leading-snug cursor-pointer">
            He leído y acepto la{' '}
            <Link href="/legal/privacidad" target="_blank" className="underline">política de privacidad</Link>
            {' '}de La Grailla para el tratamiento de estos datos. *
          </Label>
        </div>
        {consentTouched && !consentAccepted && (
          <p className="text-xs text-destructive -mt-2">Debes aceptar la política de privacidad para enviar la solicitud</p>
        )}
        <Button onClick={handleSubmit} disabled={loading} className="gap-2">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {loading ? 'Enviando...' : 'Enviar Solicitud'}
        </Button>
      </CardContent>
    </Card>
  );
}
