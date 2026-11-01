'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { CaptchaWidget, type CaptchaWidgetHandle } from '@/components/captcha-widget';
import { normalizePublicUrl } from '@/lib/safe-url';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { CheckCircle, Loader2, Send } from 'lucide-react';
import { toast } from 'sonner';
import { useBrand } from '@/components/brand-provider';

type FormState = {
  companyName: string;
  contactName: string;
  email: string;
  phone: string;
  website: string;
  message: string;
};

type FieldErrors = Partial<Record<keyof FormState, string>>;

function validateField(key: keyof FormState, value: string): string | undefined {
  switch (key) {
    case 'companyName':
      return value.trim() ? undefined : 'Indica el nombre de la empresa';
    case 'contactName':
      if (!value.trim()) return 'Indica una persona de contacto';
      // Mismo criterio que el servidor: este nombre sale en la confirmación que se manda al email indicado.
      return /:\/\/|www\.|@/i.test(value) ? 'El nombre no puede incluir enlaces ni direcciones' : undefined;
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? undefined : 'Introduce un email válido';
    case 'website':
      return !value.trim() || normalizePublicUrl(value) ? undefined : 'Escribe una dirección web válida, por ejemplo https://tuempresa.com';
    default:
      return undefined;
  }
}

export default function SponsorForm({ captchaSiteKey = '' }: { /** Clave pública del captcha (Turnstile) del cliente; vacía = sin captcha. */ captchaSiteKey?: string }) {
  const { name: brandName } = useBrand();
  // Captcha: cada token vale para un único envío, así que se pide otro tras cada respuesta.
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const captchaRef = useRef<CaptchaWidgetHandle>(null);
  // Si el script de Cloudflare no carga (bloqueador de anuncios, red), se envía sin token y decide el servidor.
  const [captchaUnavailable, setCaptchaUnavailable] = useState(false);
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState<FormState>({
    companyName: '',
    contactName: '',
    email: '',
    phone: '',
    website: '',
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
    setTouched({ companyName: true, contactName: true, email: true, phone: true, website: true, message: true });
    setConsentTouched(true);

    if (Object.keys(fieldErrors).length > 0) {
      toast.error('Revisa los campos marcados en rojo');
      return;
    }
    if (!consentAccepted) {
      toast.error('Debes aceptar la política de privacidad para continuar');
      return;
    }

    if (captchaSiteKey && !captchaToken && !captchaUnavailable) {
      toast.error('Estamos haciendo una comprobación de seguridad. Inténtalo de nuevo en unos segundos.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/sponsors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, consentAccepted: true, captchaToken: captchaToken ?? undefined }),
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
      if (captchaSiteKey) captchaRef.current?.reset();
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
            {errors.companyName && <p className="text-xs text-destructive-text mt-1">{errors.companyName}</p>}
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
            {errors.contactName && <p className="text-xs text-destructive-text mt-1">{errors.contactName}</p>}
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
            {errors.email && <p className="text-xs text-destructive-text mt-1">{errors.email}</p>}
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
            onBlur={handleBlur('website')}
            className="mt-1"
            placeholder="https://tuempresa.com o instagram.com/tuempresa"
            aria-invalid={Boolean(errors.website)}
          />
          {errors.website ? (
            <p className="text-xs text-destructive-text mt-1">{errors.website}</p>
          ) : (
            <p className="text-xs text-muted-foreground mt-1">Nos ayuda a conocer tu marca para adaptar mejor el material que preparemos.</p>
          )}
        </div>
        <div>
          <Label>Mensaje</Label>
          <Textarea
            value={form.message}
            onChange={handleChange('message')}
            className="mt-1"
            placeholder="Cuéntanos qué tipo de patrocinio te interesa (evento, espacio físico, ambos...) y cualquier otro detalle de tu propuesta."
            rows={4}
          />
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
            {' '}de {brandName} para el tratamiento de estos datos. *
          </Label>
        </div>
        {consentTouched && !consentAccepted && (
          <p className="text-xs text-destructive-text -mt-2">Debes aceptar la política de privacidad para enviar la solicitud</p>
        )}
        {captchaSiteKey && (
          <CaptchaWidget
            ref={captchaRef}
            siteKey={captchaSiteKey}
            action="sponsor"
            onToken={(t) => {
              setCaptchaToken(t);
              if (t) setCaptchaUnavailable(false);
            }}
            onUnavailable={() => setCaptchaUnavailable(true)}
          />
        )}
        <Button onClick={handleSubmit} disabled={loading} className="gap-2">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {loading ? 'Enviando...' : 'Enviar Solicitud'}
        </Button>
      </CardContent>
    </Card>
  );
}
