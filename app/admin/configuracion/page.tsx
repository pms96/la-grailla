'use client';

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import type { AppConfig } from '@prisma/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Loader2, Save, FileText, Globe, Wallet, Sparkles, Handshake, Ticket, ShoppingBag, Plug, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layouts/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfigField } from '@/app/admin/_components/config-field';
import { SponsorTiersConfig } from '@/app/admin/_components/sponsor-tiers-config';
import { useBrand } from '@/components/brand-provider';
import { ownerEnabled } from '@/lib/modules/registry';
import { PaymentAccount } from './_sections/payment-account';
import { PrinterSettings } from './_sections/printer-settings';

/* La configuración se organiza POR MÓDULO: cada módulo tiene su pestaña con sus ajustes (cobros, comisión, textos…) y solo aparece si el
 * cliente lo tiene. Lo que usan varios módulos (correo saliente, clave de IA) está en «Conexiones». Entradas y Tienda tienen cada una su
 * cuenta de cobro. La API (lib/config-ownership.ts) hace cumplir lo mismo en el servidor: no es solo ocultar pestañas. */
export default function ConfiguracionPage() {
  const { contactFormEnabled, modules } = useBrand();
  const { data: session, status: sessionStatus } = useSession() || {};
  // Con un rol por módulos solo salen las pestañas de SUS módulos (la API filtra las claves igual: esto solo evita pestañas vacías).
  const userModules = session?.user?.modules ?? null;
  const mine = (m: Parameters<typeof ownerEnabled>[0]) => userModules === null || userModules.includes(m);
  const has = (m: Parameters<typeof ownerEnabled>[0]) => ownerEnabled(m, modules) && mine(m);
  const core = mine('nucleo');
  // El correo saliente y el email de administración son solo del propietario (un rol restringido no puede desviar los correos): la API los ignora igual.
  const owner = sessionStatus === 'authenticated' && userModules === null; // hasta cargar la sesión no se enseñan (evita el parpadeo para un rol restringido)
  const showConnections = owner || has('sponsors') || has('contabilidad');
  const [configs, setConfigs] = useState<AppConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});

  const loadConfigs = () =>
    fetch('/api/admin/config')
      .then((r) => r.json())
      .then((d) => {
        setConfigs(d ?? []);
        const vals: Record<string, string> = {};
        (d ?? []).forEach((c: AppConfig) => { vals[c?.key ?? ''] = c?.value ?? ''; });
        setValues(vals);
      })
      .catch(() => {});

  useEffect(() => {
    loadConfigs().finally(() => setLoading(false));
  }, []);

  const updateValue = (key: string, value: string) => {
    setValues((prev) => ({ ...(prev ?? {}), [key]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const configsToSave = Object.entries(values ?? {}).map(([key, value]) => {
        const existing = configs?.find((c) => c?.key === key);
        return { key, value, label: existing?.label ?? key, group: existing?.group ?? 'general' };
      });
      const res = await fetch('/api/admin/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ configs: configsToSave }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast.error(data?.error ?? 'Error al guardar');
        return;
      }
      toast.success('Configuración guardada');
      // Las credenciales son de solo escritura: tras guardar, el formulario vuelve
      // a mostrar la máscara en vez de conservar el valor que se acaba de escribir.
      await loadConfigs();
    } catch {
      toast.error('Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;

  const firstTab = has('entradas') ? 'entradas' : has('tienda') ? 'tienda' : has('wallets') ? 'wallet' : has('sponsors') ? 'sponsors' : core ? 'content' : 'connections';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <PageHeader title="Configuración" description="Ajustes de cada módulo de tu web" />
        <Button onClick={handleSave} disabled={saving} className="gap-2">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Guardar
        </Button>
      </div>

      <Tabs defaultValue={firstTab}>
        <TabsList className="flex-wrap h-auto">
          {has('entradas') && <TabsTrigger value="entradas" className="gap-2"><Ticket className="h-3.5 w-3.5" /> Entradas</TabsTrigger>}
          {has('tienda') && <TabsTrigger value="tienda" className="gap-2"><ShoppingBag className="h-3.5 w-3.5" /> Tienda</TabsTrigger>}
          {has('wallets') && <TabsTrigger value="wallet" className="gap-2"><Wallet className="h-3.5 w-3.5" /> Wallets</TabsTrigger>}
          {has('sponsors') && <TabsTrigger value="sponsors" className="gap-2"><Handshake className="h-3.5 w-3.5" /> Sponsors</TabsTrigger>}
          {core && <TabsTrigger value="content" className="gap-2"><Sparkles className="h-3.5 w-3.5" /> Contenido</TabsTrigger>}
          {core && <TabsTrigger value="social" className="gap-2"><Globe className="h-3.5 w-3.5" /> Redes sociales</TabsTrigger>}
          {showConnections && <TabsTrigger value="connections" className="gap-2"><Plug className="h-3.5 w-3.5" /> Conexiones</TabsTrigger>}
          {core && <TabsTrigger value="legal" className="gap-2"><FileText className="h-3.5 w-3.5" /> Legal</TabsTrigger>}
          {core && <TabsTrigger value="general" className="gap-2"><Settings2 className="h-3.5 w-3.5" /> General</TabsTrigger>}
        </TabsList>

        {has('entradas') && (
          <TabsContent value="entradas">
            <div className="space-y-6">
              <Card><CardContent className="p-6 space-y-4">
                <div>
                  <h3 className="font-semibold">Cobros de entradas</h3>
                  <p className="text-sm text-muted-foreground">La cuenta donde se cobran las entradas. La tienda tiene la suya, aparte.</p>
                </div>
                <PaymentAccount prefix="" values={values} onChange={updateValue} webhookPath="/api/webhooks/stripe" />
                <ConfigField label="Comisión por entrada (%)" type="number" value={values?.commission_percentage ?? '0'} onChange={(v) => updateValue('commission_percentage', v)} description="Se suma al precio de cada entrada y se muestra al comprador como gastos de distribución." />
                <ConfigField label="IVA de las entradas (%)" type="number" value={values?.vat_rate_entradas ?? ''} onChange={(v) => updateValue('vat_rate_entradas', v)} placeholder="Sin configurar" description="Tipo de IVA incluido en el precio (el que te indique tu gestoría). Con él, el justificante de compra desglosa base y cuota; vacío = no desglosa nada. Se aplica a los pedidos nuevos; los anteriores conservan el suyo. Pon 0 si no aplicas IVA." />
              </CardContent></Card>

              <Card><CardContent className="p-6 space-y-4">
                <div>
                  <h3 className="font-semibold">Seguridad de las compras</h3>
                  <p className="text-sm text-muted-foreground">Límite anti-abuso de compras por IP. Se aplica de forma global a todos los eventos, para evitar bots o compras masivas automatizadas.</p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <ConfigField label="Máx. pedidos por IP" type="number" value={values?.orders_rate_limit_per_ip ?? '10'} onChange={(v) => updateValue('orders_rate_limit_per_ip', v)} />
                  <ConfigField label="Ventana de tiempo (segundos)" type="number" value={values?.orders_rate_limit_window_seconds ?? '60'} onChange={(v) => updateValue('orders_rate_limit_window_seconds', v)} />
                  <ConfigField label="Máx. pedidos sin pagar por IP y evento" type="number" value={values?.orders_max_pending_per_ip ?? '10'} onChange={(v) => updateValue('orders_max_pending_per_ip', v)} description="Pedidos que una misma IP puede tener abiertos a la vez en la pasarela. Es un freno contra scripts, no una defensa completa. Si muchos compradores comparten red (wifi de un recinto), sube el valor." />
                </div>
                <p className="text-xs text-muted-foreground">Con los valores por defecto, una misma IP no puede crear más de 10 pedidos cada 60 segundos. Si el lanzamiento espera mucho tráfico legítimo desde la misma red (wifi compartido, datos móviles), sube estos valores.</p>
              </CardContent></Card>

              <Card><CardContent className="p-6 space-y-4">
                <div>
                  <h3 className="font-semibold">Jornada de caja</h3>
                  <p className="text-sm text-muted-foreground">Cuándo termina «el día» para el cuadre de caja y las ventas por día.</p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <ConfigField label="Hora de corte de la jornada (0 a 12, hora de Madrid)" type="number" value={values?.jornada_corte_hora ?? '0'} onChange={(v) => updateValue('jornada_corte_hora', v)} description="0 = día natural (de 00:00 a 00:00). Pon 6 si vendes de madrugada: la jornada del sábado va del sábado a las 06:00 al domingo a las 06:00, así que una noche de 22:00 a 04:00 queda entera en el sábado y se compara con la caja que anotas ese día." />
                </div>
                <p className="text-xs text-muted-foreground">Cambiarlo reagrupa también las ventas ya hechas (son los mismos pedidos, repartidos en jornadas distintas); no modifica ningún importe.</p>
              </CardContent></Card>

              <Card><CardContent className="p-6 space-y-4">
                <h3 className="font-semibold">Avisos de entradas</h3>
                <ConfigField label="Avisar a (opcional)" value={values?.notify_email_entradas ?? ''} onChange={(v) => updateValue('notify_email_entradas', v)} placeholder="Por defecto, el email de administración" description="Aforo casi completo, pagos que no cuadran y certificados de Wallet a punto de caducar." />
              </CardContent></Card>

              <Card><CardContent className="p-6 space-y-4">
                <h3 className="font-semibold">Textos de la portada</h3>
                <ConfigField label="Subtítulo de «más fechas»" value={values?.home_events_more_subtitle ?? ''} onChange={(v) => updateValue('home_events_more_subtitle', v)} description="Bajo el título de la lista de próximos eventos." />
              </CardContent></Card>

              <Card><CardContent className="p-6 space-y-4">
                <h3 className="font-semibold">Impresora de taquilla</h3>
                <PrinterSettings values={values} onChange={updateValue} />
              </CardContent></Card>
            </div>
          </TabsContent>
        )}

        {has('tienda') && (
          <TabsContent value="tienda">
            <div className="space-y-6">
              <Card><CardContent className="p-6 space-y-4">
                <div>
                  <h3 className="font-semibold">Cobros de la tienda</h3>
                  <p className="text-sm text-muted-foreground">La tienda cobra en SU cuenta, distinta de la de entradas.</p>
                </div>
                <PaymentAccount
                  prefix="shop_"
                  values={values}
                  onChange={updateValue}
                  webhookPath="/api/webhooks/stripe-tienda"
                  unsetHint={has('entradas') ? 'Mientras no elijas una pasarela aquí, la tienda sigue cobrando con la cuenta de Entradas. Elige una y guarda para darle cuenta propia.' : undefined}
                />
              </CardContent></Card>

              <Card><CardContent className="p-6 space-y-4">
                <h3 className="font-semibold">IVA de la tienda</h3>
                <ConfigField label="IVA de los productos (%)" type="number" value={values?.vat_rate_tienda ?? ''} onChange={(v) => updateValue('vat_rate_tienda', v)} placeholder="Sin configurar" description="Tipo de IVA incluido en el precio (el que te indique tu gestoría). Con él, el justificante de compra desglosa base y cuota; vacío = no desglosa nada. Se aplica a los pedidos nuevos; los anteriores conservan el suyo." />
              </CardContent></Card>

              <Card><CardContent className="p-6 space-y-4">
                <h3 className="font-semibold">Seguridad de las compras</h3>
                <ConfigField label="Máx. pedidos sin pagar por IP" type="number" value={values?.shop_orders_max_pending_per_ip ?? '10'} onChange={(v) => updateValue('shop_orders_max_pending_per_ip', v)} description="Pedidos que una misma IP puede tener abiertos a la vez en la pasarela. Es un freno contra scripts que acaparan stock, no una defensa completa. Si muchos compradores comparten red, sube el valor." />
              </CardContent></Card>

              <Card><CardContent className="p-6 space-y-4">
                <h3 className="font-semibold">Avisos de la tienda</h3>
                <ConfigField label="Avisar a (opcional)" value={values?.notify_email_tienda ?? ''} onChange={(v) => updateValue('notify_email_tienda', v)} placeholder="Por defecto, el email de administración" description="Cada pedido nuevo pagado (con líneas, talla y dirección de envío), pagos que no cuadran o llegan sobre un pedido ya anulado." />
              </CardContent></Card>

              <Card><CardContent className="p-6 space-y-4">
                <h3 className="font-semibold">Textos de la portada</h3>
                <ConfigField label="Título de la tienda" value={values?.home_shop_title ?? ''} onChange={(v) => updateValue('home_shop_title', v)} />
                <ConfigField label="Subtítulo de la tienda" value={values?.home_shop_subtitle ?? ''} onChange={(v) => updateValue('home_shop_subtitle', v)} />
              </CardContent></Card>
            </div>
          </TabsContent>
        )}

        {has('wallets') && (
          <TabsContent value="wallet">
            <Card><CardContent className="p-6 space-y-6">
              <p className="text-sm text-muted-foreground">Los botones de Apple Wallet y Google Wallet solo aparecen en las entradas cuando estas credenciales están completas. Requieren una cuenta de desarrollador de Apple y un emisor de Google Wallet.</p>
              <div className="rounded-lg border border-border p-4 space-y-4">
                <h4 className="font-semibold text-sm">Google Wallet</h4>
                <ConfigField label="Issuer ID" value={values?.google_wallet_issuer_id ?? ''} onChange={(v) => updateValue('google_wallet_issuer_id', v)} placeholder="3388000000022..." />
                <ConfigField label="Service Account JSON" type="textarea" rows={5} value={values?.google_wallet_service_account ?? ''} onChange={(v) => updateValue('google_wallet_service_account', v)} placeholder='{"client_email": "...", "private_key": "..."}' />
              </div>
              <div className="rounded-lg border border-border p-4 space-y-4">
                <h4 className="font-semibold text-sm">Apple Wallet</h4>
                <div>
                  <Label>Activar Apple Wallet</Label>
                  <Select value={values?.apple_wallet_enabled ?? 'false'} onValueChange={(v: string) => updateValue('apple_wallet_enabled', v)}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="false">Desactivado</SelectItem>
                      <SelectItem value="true">Activado</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <ConfigField label="Pass Type ID" value={values?.apple_wallet_pass_type_id ?? ''} onChange={(v) => updateValue('apple_wallet_pass_type_id', v)} placeholder="pass.com.tuempresa.entrada" />
                  <ConfigField label="Team ID" value={values?.apple_wallet_team_id ?? ''} onChange={(v) => updateValue('apple_wallet_team_id', v)} />
                  <ConfigField label="Contraseña del certificado" type="password" value={values?.apple_wallet_cert_password ?? ''} onChange={(v) => updateValue('apple_wallet_cert_password', v)} />
                </div>
                <ConfigField label="Certificado .p12 (en base64)" type="textarea" rows={4} value={values?.apple_wallet_cert_p12_base64 ?? ''} onChange={(v) => updateValue('apple_wallet_cert_p12_base64', v)} />
              </div>
            </CardContent></Card>
          </TabsContent>
        )}

        {has('sponsors') && (
          <TabsContent value="sponsors">
            <div className="space-y-6">
              <Card><CardContent className="p-6 space-y-6">
                <SponsorTiersConfig value={values?.sponsor_tiers ?? ''} onChange={(v) => updateValue('sponsor_tiers', v)} />
                <div className="pt-4 border-t border-border">
                  <ConfigField
                    label="Mensaje de pago pendiente"
                    type="textarea"
                    rows={3}
                    value={values?.sponsor_payment_pending_message ?? ''}
                    onChange={(v) => updateValue('sponsor_payment_pending_message', v)}
                    description="Lo ve el sponsor en su portal, en el paso de pago, mientras no lo hayamos marcado como pagado — se le añade automáticamente el importe de su tipo de patrocinio."
                  />
                </div>
              </CardContent></Card>
              <Card><CardContent className="p-6 space-y-4">
                <h3 className="font-semibold">Avisos de sponsors</h3>
                <ConfigField label="Avisar a (opcional)" value={values?.notify_email_sponsors ?? ''} onChange={(v) => updateValue('notify_email_sponsors', v)} placeholder="Por defecto, el email de administración" description="Nuevas solicitudes de patrocinio." />
              </CardContent></Card>
              <Card><CardContent className="p-6 space-y-4">
                <h3 className="font-semibold">Textos de la portada</h3>
                <ConfigField label="Título del CTA de sponsors" value={values?.home_sponsors_cta_title ?? ''} onChange={(v) => updateValue('home_sponsors_cta_title', v)} />
                <ConfigField label="Subtítulo del CTA de sponsors" value={values?.home_sponsors_cta_subtitle ?? ''} onChange={(v) => updateValue('home_sponsors_cta_subtitle', v)} />
              </CardContent></Card>
            </div>
          </TabsContent>
        )}

        <TabsContent value="content">
          <Card><CardContent className="p-6 space-y-4">
            <p className="text-sm text-muted-foreground">Textos que se muestran en la home y el footer de la web pública. Déjalos vacíos para usar el texto por defecto. Los textos de cada sección de negocio (eventos, tienda, sponsors) están en la pestaña de su módulo.</p>
            <div className="rounded-lg border border-border p-4 space-y-4">
              <h4 className="font-semibold text-sm">Home</h4>
              <ConfigField
                label="Badge del hero (cuando no hay próximo evento)"
                value={values?.home_hero_badge_fallback ?? ''}
                onChange={(v) => updateValue('home_hero_badge_fallback', v)}
              />
              <ConfigField label="Subtítulo principal" value={values?.home_hero_subtitle_1 ?? ''} onChange={(v) => updateValue('home_hero_subtitle_1', v)} />
              <ConfigField label="Subtítulo secundario" value={values?.home_hero_subtitle_2 ?? ''} onChange={(v) => updateValue('home_hero_subtitle_2', v)} />
            </div>
            <div className="rounded-lg border border-border p-4 space-y-4">
              <h4 className="font-semibold text-sm">Sobre nosotros</h4>
              <p className="text-xs text-muted-foreground">Una sección con tu presentación. Si dejas el texto vacío, no se muestra.</p>
              <ConfigField label="Título" value={values?.home_about_title ?? ''} onChange={(v) => updateValue('home_about_title', v)} placeholder="Por defecto: «Sobre» y tu nombre" />
              <ConfigField label="Texto" type="textarea" rows={5} value={values?.home_about_text ?? ''} onChange={(v) => updateValue('home_about_text', v)} />
            </div>
            <div className="rounded-lg border border-border p-4 space-y-4">
              <h4 className="font-semibold text-sm">Contacto</h4>
              <div>
                <Label>Formulario de contacto en la portada</Label>
                <Select value={values?.contact_form_enabled ?? String(contactFormEnabled)} onValueChange={(v: string) => updateValue('contact_form_enabled', v)}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">Mostrar</SelectItem>
                    <SelectItem value="false">Ocultar</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">Los mensajes llegan a «Mensajes» en este panel y se avisa al email de administración (o al que pongas aquí).</p>
              </div>
              <ConfigField label="Avisar de los mensajes a (opcional)" value={values?.notify_email_contacto ?? ''} onChange={(v) => updateValue('notify_email_contacto', v)} placeholder="Por defecto, el email de administración" />
            </div>
            <div className="rounded-lg border border-border p-4 space-y-4">
              <h4 className="font-semibold text-sm">Footer</h4>
              <ConfigField label="Tagline" value={values?.footer_tagline ?? ''} onChange={(v) => updateValue('footer_tagline', v)} />
              <ConfigField label="Copyright" value={values?.footer_copyright ?? ''} onChange={(v) => updateValue('footer_copyright', v)} />
            </div>
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="social">
          <Card><CardContent className="p-6 space-y-4">
            <ConfigField label="Instagram" value={values?.social_instagram ?? ''} onChange={(v) => updateValue('social_instagram', v)} placeholder="https://instagram.com/tu-cuenta" />
            <ConfigField label="TikTok" value={values?.social_tiktok ?? ''} onChange={(v) => updateValue('social_tiktok', v)} placeholder="https://tiktok.com/@tu-cuenta" />
            <ConfigField label="Twitter/X" value={values?.social_twitter ?? ''} onChange={(v) => updateValue('social_twitter', v)} />
            <ConfigField label="Facebook" value={values?.social_facebook ?? ''} onChange={(v) => updateValue('social_facebook', v)} />
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="connections">
          <div className="space-y-6">
            {owner && (
            <Card><CardContent className="p-6 space-y-4">
              <div>
                <h3 className="font-semibold">Correo saliente (SMTP)</h3>
                <p className="text-sm text-muted-foreground">Lo usan todos los módulos para sus avisos y confirmaciones. Si activas el SMTP propio, los correos (y las entradas en PDF) salen de tu servidor de correo. Si lo dejas desactivado, se usa el servicio de correo integrado y el PDF se envía como enlace de descarga.</p>
              </div>
              <div>
                <Label>Envío por SMTP propio</Label>
                <Select value={values?.smtp_enabled ?? 'false'} onValueChange={(v: string) => updateValue('smtp_enabled', v)}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="false">Desactivado (servicio integrado)</SelectItem>
                    <SelectItem value="true">Activado</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <ConfigField label="Servidor SMTP" value={values?.smtp_host ?? ''} onChange={(v) => updateValue('smtp_host', v)} placeholder="smtp.tudominio.com" />
                <ConfigField label="Puerto" value={values?.smtp_port ?? ''} onChange={(v) => updateValue('smtp_port', v)} placeholder="587" />
                <ConfigField label="Usuario" value={values?.smtp_user ?? ''} onChange={(v) => updateValue('smtp_user', v)} />
                <ConfigField label="Contraseña" type="password" value={values?.smtp_password ?? ''} onChange={(v) => updateValue('smtp_password', v)} />
                <div>
                  <Label>Conexión segura (SSL/TLS)</Label>
                  <Select value={values?.smtp_secure ?? 'true'} onValueChange={(v: string) => updateValue('smtp_secure', v)}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="true">Sí (puerto 465)</SelectItem>
                      <SelectItem value="false">No (STARTTLS, puerto 587)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <ConfigField label="Email remitente" value={values?.smtp_from_email ?? ''} onChange={(v) => updateValue('smtp_from_email', v)} placeholder="entradas@tudominio.com" />
                <ConfigField label="Nombre remitente" value={values?.smtp_from_name ?? ''} onChange={(v) => updateValue('smtp_from_name', v)} placeholder="Nombre de tu negocio" />
              </div>
            </CardContent></Card>
            )}

            {(has('sponsors') || has('contabilidad')) && (
              <Card><CardContent className="p-6 space-y-4">
                <div>
                  <h3 className="font-semibold">Inteligencia artificial (Abacus.AI)</h3>
                  <p className="text-sm text-muted-foreground">
                    {has('sponsors') ? 'Genera el prompt de vídeo en el portal de sponsors a partir del logo y las respuestas del sponsor. ' : ''}
                    {has('contabilidad') ? 'Lee la imagen de un artículo en Compras. ' : ''}
                    Sin API key se usa un texto de ejemplo (modo prueba), útil para probar el flujo sin gastar generaciones reales.
                  </p>
                </div>
                <ConfigField
                  label="API Key de Abacus.AI"
                  type="password"
                  value={values?.abacus_ai_api_key ?? ''}
                  onChange={(v) => updateValue('abacus_ai_api_key', v)}
                  description="La API key de tu cuenta de Abacus.AI (RouteLLM — https://abacus.ai/app/route-llm-apis)."
                />
              </CardContent></Card>
            )}
          </div>
        </TabsContent>

        <TabsContent value="legal">
          <Card><CardContent className="p-6 space-y-4">
            <ConfigField label="Aviso Legal" type="textarea" rows={6} value={values?.legal_notice ?? ''} onChange={(v) => updateValue('legal_notice', v)} />
            <ConfigField label="Política de Privacidad" type="textarea" rows={6} value={values?.privacy_policy ?? ''} onChange={(v) => updateValue('privacy_policy', v)} />
            <ConfigField label="Política de Cookies" type="textarea" rows={6} value={values?.cookies_policy ?? ''} onChange={(v) => updateValue('cookies_policy', v)} />
          </CardContent></Card>

          <Card className="mt-6"><CardContent className="p-6 space-y-4">
            <div>
              <h3 className="font-semibold">Datos del vendedor (justificante de compra)</h3>
              <p className="text-sm text-muted-foreground">Salen en la pantalla de confirmación y en el correo de cada compra. La plataforma no emite facturas: el justificante lo dice y el comprador la pide por correo. Sin NIF no se imprime ningún dato del vendedor.</p>
            </div>
            <ConfigField label="Razón social" value={values?.fiscal_legal_name ?? ''} onChange={(v) => updateValue('fiscal_legal_name', v)} placeholder="Por defecto, la razón social de la marca" />
            <ConfigField label="NIF / CIF" value={values?.fiscal_nif ?? ''} onChange={(v) => updateValue('fiscal_nif', v)} />
            <ConfigField label="Domicilio fiscal" value={values?.fiscal_address ?? ''} onChange={(v) => updateValue('fiscal_address', v)} />
          </CardContent></Card>

          {has('entradas') && (
            <Card className="mt-6"><CardContent className="p-6 space-y-4">
              <ConfigField label="Condiciones de venta de entradas" type="textarea" rows={10} value={values?.legal_terms_entradas ?? ''} onChange={(v) => updateValue('legal_terms_entradas', v)} description="Se muestran en /legal/condiciones-entradas y el comprador las acepta antes de pagar. Si lo dejas vacío se usa un texto orientativo por defecto: revísalo con tu asesor antes de vender." />
            </CardContent></Card>
          )}
          {has('tienda') && (
            <Card className="mt-6"><CardContent className="p-6 space-y-4">
              <ConfigField label="Condiciones de venta de la tienda (desistimiento y devoluciones)" type="textarea" rows={10} value={values?.legal_terms_tienda ?? ''} onChange={(v) => updateValue('legal_terms_tienda', v)} description="Se muestran en /legal/condiciones-tienda y el comprador las acepta antes de pagar. Si lo dejas vacío se usa un texto orientativo por defecto: revísalo con tu asesor antes de vender." />
            </CardContent></Card>
          )}
        </TabsContent>

        <TabsContent value="general">
          {/* El banner de cookies ya no se puede apagar desde aquí: el selector «Ocultar» no hacía nada (el banner se mostraba igual) y la web usa
              cookies de terceros (pagos, anti-bots) sobre las que hay que informar. */}
          {owner && (
            <Card><CardContent className="p-6 space-y-4">
              <ConfigField label="Email de administración" value={values?.admin_email ?? ''} onChange={(v) => updateValue('admin_email', v)} />
            </CardContent></Card>
          )}

          <Card className="mt-6"><CardContent className="p-6 space-y-4">
            <div>
              <h3 className="font-display font-semibold">Comprobación anti-bots (Cloudflare Turnstile)</h3>
              <p className="text-sm text-muted-foreground">Frena a los scripts que reservan entradas o stock sin pagar. Se pide al entrar en la sala de espera y al crear un pedido, y casi siempre es invisible para el comprador. Crea un widget gratuito en el panel de Cloudflare (Turnstile → Add widget), añade el dominio de esta web y pega aquí sus dos claves. Si dejas una vacía, la comprobación queda desactivada.</p>
            </div>
            <ConfigField label="Clave del sitio (pública)" value={values?.turnstile_site_key ?? ''} onChange={(v) => updateValue('turnstile_site_key', v)} placeholder="0x4AAAAAAA..." />
            <ConfigField label="Clave secreta" type="password" value={values?.turnstile_secret_key ?? ''} onChange={(v) => updateValue('turnstile_secret_key', v)} placeholder="0x4AAAAAAA..." description="Se guarda cifrada y no se vuelve a mostrar. Si Cloudflare no responde, la compra no se bloquea." />
          </CardContent></Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
