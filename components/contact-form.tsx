'use client';

import { useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useBrand } from '@/components/brand-provider';

/* Formulario de contacto de la portada (núcleo). El campo `website` es una trampa para bots: está fuera de pantalla y fuera del orden de
 * tabulación; una persona nunca lo rellena (ver lib/contact.ts). */

type Form = { name: string; email: string; phone: string; subject: string; message: string; website: string };
const EMPTY: Form = { name: '', email: '', phone: '', subject: '', message: '', website: '' };

export function ContactForm() {
  const { name: brandName } = useBrand();
  const [form, setForm] = useState<Form>(EMPTY);
  const [consent, setConsent] = useState(false);
  const [consentTouched, setConsentTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setConsentTouched(true);
    if (!consent) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, consentAccepted: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data?.error === 'string' && data.error !== 'validation_error' && data.code !== 'validation_error' ? data.error : 'No hemos podido enviar tu mensaje. Revisa los datos e inténtalo de nuevo.');
        return;
      }
      setSent(true);
      setForm(EMPTY);
    } catch {
      setError('Fallo de conexión. Inténtalo de nuevo en unos segundos.');
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <div role="status" className="flex items-start gap-3 rounded-lg border border-border bg-card p-6">
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
        <div>
          <p className="font-display text-lg font-semibold">Mensaje enviado</p>
          <p className="mt-1 text-sm text-muted-foreground">Gracias por escribirnos. Te responderemos al email que nos has dado.</p>
          <Button variant="ghost" size="sm" className="mt-3 -ml-2" onClick={() => setSent(false)}>Enviar otro mensaje</Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="contact-name">Nombre *</Label>
          <Input id="contact-name" className="mt-1" value={form.name} onChange={set('name')} maxLength={120} autoComplete="name" required />
        </div>
        <div>
          <Label htmlFor="contact-email">Email *</Label>
          <Input id="contact-email" type="email" className="mt-1" value={form.email} onChange={set('email')} maxLength={255} autoComplete="email" required />
        </div>
        <div>
          <Label htmlFor="contact-phone">Teléfono</Label>
          <Input id="contact-phone" type="tel" className="mt-1" value={form.phone} onChange={set('phone')} maxLength={30} autoComplete="tel" />
        </div>
        <div>
          <Label htmlFor="contact-subject">Asunto</Label>
          <Input id="contact-subject" className="mt-1" value={form.subject} onChange={set('subject')} maxLength={150} />
        </div>
      </div>
      <div>
        <Label htmlFor="contact-message">Mensaje *</Label>
        <Textarea id="contact-message" className="mt-1" rows={5} value={form.message} onChange={set('message')} maxLength={5000} required />
      </div>

      {/* Trampa para bots: fuera de pantalla, sin foco y oculta a lectores de pantalla. */}
      <div aria-hidden className="absolute left-[-10000px] top-auto h-px w-px overflow-hidden">
        <label>
          No rellenes este campo
          <input type="text" name="website" tabIndex={-1} autoComplete="off" value={form.website} onChange={set('website')} />
        </label>
      </div>

      <div className="flex items-start gap-2">
        <Checkbox
          id="contact-consent"
          checked={consent}
          onCheckedChange={(v) => { setConsent(v === true); setConsentTouched(true); }}
          className="mt-0.5"
          aria-invalid={consentTouched && !consent}
        />
        <Label htmlFor="contact-consent" className="cursor-pointer text-xs font-normal leading-snug text-muted-foreground">
          He leído y acepto la{' '}
          <Link href="/legal/privacidad" target="_blank" className="underline">política de privacidad</Link>
          {' '}de {brandName} para el tratamiento de estos datos. *
        </Label>
      </div>
      {consentTouched && !consent && <p className="-mt-2 text-xs text-destructive-text">Debes aceptar la política de privacidad para enviar el mensaje</p>}
      {error && <p role="alert" className="text-sm text-destructive-text">{error}</p>}

      <Button type="submit" disabled={sending} className="gap-2">
        {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        {sending ? 'Enviando…' : 'Enviar mensaje'}
      </Button>
    </form>
  );
}
