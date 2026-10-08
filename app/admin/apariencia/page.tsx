'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Save, RotateCcw, Palette, Type, Image as ImageIcon, LayoutTemplate, Sparkles, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/layouts/page-header';
import { cn } from '@/lib/utils';
import { ImageUploadField } from '@/app/admin/_components/image-upload-field';
import {
  FONT_CATALOG, FONT_KEYS, MODES, RADII, RADIUS_VALUE, TEMPLATES, TEMPLATE_LABELS,
  deriveTokens, hexToHsl, hslToHex, themeContrastIssues, themeContrastWarnings,
  type FontKey, type ModeKey, type RadiusKey, type SiteTheme, type TemplateKey, type TokenSet,
} from '@/lib/brand/theme';

/* Apariencia: logo, colores, tipografías, forma de las esquinas, plantilla y textos de marca del cliente. Lo que se elige aquí es lo ÚNICO
 * que cambia la web: el resto de colores (texto, bordes, tarjetas…) se deriva con contraste legible. La vista previa usa el mismo cálculo
 * que el servidor, así que lo que se ve es lo que se publica. */

const MODE_LABELS: Record<ModeKey, string> = { dark: 'Oscuro', light: 'Claro', system: 'El del dispositivo' };
const RADIUS_LABELS: Record<RadiusKey, string> = { recto: 'Rectas', suave: 'Suaves', redondo: 'Redondeadas' };

type Loaded = { theme: SiteTheme; saved: boolean; legacy: boolean };

function tokenStyle(set: TokenSet, radius: RadiusKey): React.CSSProperties {
  const vars: Record<string, string> = { '--radius': RADIUS_VALUE[radius] };
  for (const [k, v] of Object.entries(set)) vars[`--${k}`] = v;
  return vars as React.CSSProperties;
}

function ColorField({ label, hint, value, onChange }: { label: string; hint?: string; value: string; onChange: (hex: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <div>
      <Label>{label}</Label>
      <div className="mt-1 flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
          aria-label={label}
          className="h-10 w-12 cursor-pointer rounded-md border border-input bg-background p-1"
        />
        <Input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) onChange(e.target.value.toLowerCase());
          }}
          className="font-mono w-32"
          spellCheck={false}
          aria-label={`${label} (hexadecimal)`}
        />
      </div>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function OptionalColorField({ label, hint, value, auto, onChange }: { label: string; hint: string; value: string | undefined; auto: string; onChange: (hex: string | undefined) => void }) {
  return (
    <div className="space-y-2">
      <ColorField label={label} value={value ?? auto} onChange={onChange} hint={hint} />
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Switch checked={value === undefined} onCheckedChange={(on: boolean) => onChange(on ? undefined : auto)} />
        Calcular automáticamente a partir del color principal
      </label>
    </div>
  );
}

/** Maqueta de la web con los colores calculados. Los componentes usan los tokens, así que se ven igual que en el sitio. */
function Preview({ theme, mode }: { theme: SiteTheme; mode: 'light' | 'dark' }) {
  const set = deriveTokens(theme)[mode];
  const logo = mode === 'dark' ? (theme.assets.logoOnDark ?? theme.assets.logoOnLight) : (theme.assets.logoOnLight ?? theme.assets.logoOnDark);
  const display = `var(${FONT_CATALOG[theme.fonts.display].cssVar}), system-ui, sans-serif`;
  const body = `var(${FONT_CATALOG[theme.fonts.body].cssVar}), system-ui, sans-serif`;
  const feria = theme.template === 'feria';
  return (
    <div
      className={cn('overflow-hidden rounded-lg border border-border text-sm', mode === 'dark' && 'dark')}
      style={{ ...tokenStyle(set, theme.radius), background: 'hsl(var(--background))', color: 'hsl(var(--foreground))', fontFamily: body }}
      aria-label={`Vista previa en modo ${mode === 'dark' ? 'oscuro' : 'claro'}`}
    >
      <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'hsl(var(--border))' }}>
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logo} alt="" className="h-6 w-auto object-contain" />
        ) : (
          <span className="text-base font-bold" style={{ fontFamily: display }}>{theme.brand.name || 'Tu marca'}</span>
        )}
        <div className="flex items-center gap-3 text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
          <span>Eventos</span><span>Tienda</span>
          {feria && theme.brand.sticker && (
            <span className="brand-sticker !px-2 !py-0.5 text-xs" style={{ color: 'hsl(var(--lima))' }}>{theme.brand.sticker}</span>
          )}
        </div>
      </div>
      <div className={cn('relative px-4 py-8', feria && 'hero-gradient')}>
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: 'hsl(var(--muted-foreground))' }}>Próximo evento</p>
        <h3 className={cn('mb-2 text-2xl leading-tight', feria ? 'font-bold' : 'font-semibold tracking-tight')} style={{ fontFamily: display }}>
          {theme.brand.tagline || 'Una frase que cuente quién eres'}
        </h3>
        <p className="mb-4 max-w-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Así se ve el texto normal de tu web.</p>
        <div className="flex items-center gap-2">
          <span
            className={cn('inline-flex h-9 items-center px-4 text-sm font-semibold', feria ? 'rounded-full' : 'rounded-md')}
            style={{ background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))', fontFamily: display }}
          >
            Comprar entradas
          </span>
          <span
            className="inline-flex h-9 items-center rounded-md px-3 text-sm font-semibold"
            style={{ background: 'hsl(var(--accent))', color: 'hsl(var(--accent-foreground))', fontFamily: display }}
          >
            Acento
          </span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 border-t p-4" style={{ borderColor: 'hsl(var(--border))' }}>
        {['Tarjeta', 'Otra tarjeta'].map((t) => (
          <div key={t} className="rounded-lg border p-3" style={{ borderColor: 'hsl(var(--border))', background: 'hsl(var(--card))', color: 'hsl(var(--card-foreground))' }}>
            <p className="font-semibold" style={{ fontFamily: display }}>{t}</p>
            <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Texto secundario</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AparienciaPage() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [theme, setTheme] = useState<SiteTheme | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () =>
    fetch('/api/admin/theme')
      .then((r) => r.json())
      .then((d: Loaded) => {
        setLoaded(d);
        setTheme(d.theme);
      })
      .catch(() => toast.error('No se ha podido cargar la apariencia'));
  useEffect(() => {
    load();
  }, []);

  const issues = useMemo(() => (theme ? themeContrastIssues(theme) : []), [theme]);
  const warnings = useMemo(() => (theme ? themeContrastWarnings(theme) : []), [theme]);
  const dirty = useMemo(() => !!theme && !!loaded && JSON.stringify(theme) !== JSON.stringify(loaded.theme), [theme, loaded]);

  if (!theme || !loaded) {
    return <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  }

  const patch = (p: Partial<SiteTheme>) => setTheme((t) => (t ? { ...t, ...p } : t));
  const setColors = (c: Partial<SiteTheme['colors']>) => setTheme((t) => (t ? { ...t, colors: { ...t.colors, ...c } } : t));
  const setAssets = (a: Partial<SiteTheme['assets']>) =>
    setTheme((t) => {
      if (!t) return t;
      const assets = { ...t.assets, ...a };
      for (const k of Object.keys(assets) as (keyof typeof assets)[]) if (!assets[k]) delete assets[k]; // '' = quitar
      return { ...t, assets };
    });
  const setBrand = (b: Partial<SiteTheme['brand']>) => setTheme((t) => (t ? { ...t, brand: { ...t.brand, ...b } } : t));

  // Superficies por defecto (las que se calculan solas), para mostrarlas en el selector.
  const auto = deriveTokens({ colors: { primary: theme.colors.primary, accent: theme.colors.accent } });
  const hslTriplet = (v: string) => {
    const [h, s, l] = v.split(' ');
    return hslToHex({ h: parseFloat(h), s: parseFloat(s), l: parseFloat(l) });
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/admin/theme', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(theme) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error([data?.error ?? 'No se ha podido guardar', ...(data?.details ?? [])].join(' '));
        return;
      }
      toast.success('Apariencia guardada');
      await load();
    } catch {
      toast.error('Error de conexión al guardar');
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!window.confirm(loaded.legacy ? 'Volver a la apariencia original del sitio. ¿Seguro?' : 'Volver a la apariencia por defecto. ¿Seguro?')) return;
    const res = await fetch('/api/admin/theme', { method: 'DELETE' });
    if (!res.ok) return toast.error('No se ha podido restablecer');
    toast.success('Apariencia restablecida');
    await load();
  };

  const roleFonts = (role: 'display' | 'body') => FONT_KEYS.filter((k) => FONT_CATALOG[k].roles.includes(role));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Apariencia"
        description="Logo, colores, tipografías y textos de marca de tu web, de los emails y de los documentos."
        actions={
          <>
            {loaded.saved && (
              <Button variant="ghost" onClick={reset} className="gap-2">
                <RotateCcw className="h-4 w-4" /> Restablecer
              </Button>
            )}
            <Button onClick={save} disabled={saving || !dirty || issues.length > 0} className="gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Guardar
            </Button>
          </>
        }
      />

      {!loaded.saved && (
        <p className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          {loaded.legacy
            ? 'Ahora mismo se usa la apariencia original del sitio. Cuando guardes, la web pasará a usar lo que elijas aquí.'
            : 'Todavía no has personalizado tu apariencia: tu web usa un diseño neutro. Elige tu logo, tus colores y tus textos.'}
        </p>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="space-y-6">
          <Card><CardContent className="space-y-4 p-6">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold"><Sparkles className="h-4 w-4 text-primary" /> Identidad</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="brand-name">Nombre</Label>
                <Input id="brand-name" className="mt-1" maxLength={60} value={theme.brand.name} onChange={(e) => setBrand({ name: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="brand-legal">Razón social</Label>
                <Input id="brand-legal" className="mt-1" maxLength={100} value={theme.brand.legalName} onChange={(e) => setBrand({ legalName: e.target.value })} placeholder="Para el pie y los textos legales" />
              </div>
            </div>
            <div>
              <Label htmlFor="brand-tagline">Eslogan</Label>
              <Input id="brand-tagline" className="mt-1" maxLength={160} value={theme.brand.tagline} onChange={(e) => setBrand({ tagline: e.target.value })} placeholder="Una frase que explique qué haces" />
            </div>
            <div>
              <Label htmlFor="brand-desc">Descripción para buscadores y redes</Label>
              <Textarea id="brand-desc" className="mt-1" rows={3} maxLength={300} value={theme.brand.description} onChange={(e) => setBrand({ description: e.target.value })} />
              <p className="mt-1 text-xs text-muted-foreground">Si la dejas vacía se usa el eslogan.</p>
            </div>
            {theme.template === 'feria' && (
              <div>
                <Label htmlFor="brand-sticker">Pegatina de la cabecera</Label>
                <Input id="brand-sticker" className="mt-1 max-w-xs" maxLength={24} value={theme.brand.sticker} onChange={(e) => setBrand({ sticker: e.target.value })} placeholder="Opcional" />
              </div>
            )}
          </CardContent></Card>

          <Card><CardContent className="space-y-4 p-6">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold"><LayoutTemplate className="h-4 w-4 text-primary" /> Plantilla</h2>
            <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Plantilla de la portada">
              {TEMPLATES.map((t: TemplateKey) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={theme.template === t}
                  onClick={() => patch({ template: t })}
                  className={cn(
                    'rounded-lg border-2 p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    theme.template === t ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'
                  )}
                >
                  <p className="font-display font-semibold">{TEMPLATE_LABELS[t].label}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{TEMPLATE_LABELS[t].description}</p>
                </button>
              ))}
            </div>
          </CardContent></Card>

          <Card><CardContent className="space-y-5 p-6">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold"><Palette className="h-4 w-4 text-primary" /> Colores</h2>
            <div className="grid gap-5 sm:grid-cols-2">
              <ColorField label="Color principal" hint="Botones, enlaces y detalles." value={theme.colors.primary} onChange={(hex) => setColors({ primary: hex })} />
              <ColorField label="Color de acento" hint="Destacados: pegatinas, etiquetas." value={theme.colors.accent} onChange={(hex) => setColors({ accent: hex })} />
              <OptionalColorField label="Fondo en modo oscuro" hint="El color de fondo de la web oscura." value={theme.colors.surfaceDark} auto={hslTriplet(auto.dark.background)} onChange={(hex) => setColors({ surfaceDark: hex })} />
              <OptionalColorField label="Fondo en modo claro" hint="El color de fondo de la web clara." value={theme.colors.surfaceLight} auto={hslTriplet(auto.light.background)} onChange={(hex) => setColors({ surfaceLight: hex })} />
            </div>
            {issues.length > 0 && (
              <div role="alert" className="flex gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <ul className="space-y-1">{issues.map((i) => <li key={i}>{i} Elige un fondo o un color con más contraste.</li>)}</ul>
              </div>
            )}
            {issues.length === 0 && warnings.length > 0 && (
              <ul className="space-y-1 rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground" aria-label="Avisos de contraste">
                {warnings.map((w) => <li key={w}>{w} Puedes guardarlo igualmente.</li>)}
              </ul>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label>Modo por defecto</Label>
                <Select value={theme.mode} onValueChange={(v: string) => patch({ mode: v as ModeKey })}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>{MODES.map((m) => <SelectItem key={m} value={m}>{MODE_LABELS[m]}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div>
                <Label>Esquinas</Label>
                <Select value={theme.radius} onValueChange={(v: string) => patch({ radius: v as RadiusKey })}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>{RADII.map((r) => <SelectItem key={r} value={r}>{RADIUS_LABELS[r]}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
          </CardContent></Card>

          <Card><CardContent className="space-y-4 p-6">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold"><Type className="h-4 w-4 text-primary" /> Tipografías</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label>Titulares</Label>
                <Select value={theme.fonts.display} onValueChange={(v: string) => patch({ fonts: { ...theme.fonts, display: v as FontKey } })}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>{roleFonts('display').map((k) => <SelectItem key={k} value={k}>{FONT_CATALOG[k].label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div>
                <Label>Texto</Label>
                <Select value={theme.fonts.body} onValueChange={(v: string) => patch({ fonts: { ...theme.fonts, body: v as FontKey } })}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>{roleFonts('body').map((k) => <SelectItem key={k} value={k}>{FONT_CATALOG[k].label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
          </CardContent></Card>

          <Card><CardContent className="space-y-4 p-6">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold"><ImageIcon className="h-4 w-4 text-primary" /> Logo e imágenes</h2>
            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                <Label>Logo para fondos oscuros</Label>
                <p className="mb-2 text-xs text-muted-foreground">La versión clara o blanca.</p>
                <ImageUploadField value={theme.assets.logoOnDark ?? ''} onChange={(url) => setAssets({ logoOnDark: url })} prefix="brand" fit="contain" previewClassName="bg-zinc-900" accept="image/png,image/jpeg" label="logo para fondos oscuros" />
              </div>
              <div>
                <Label>Logo para fondos claros</Label>
                <p className="mb-2 text-xs text-muted-foreground">La versión oscura. También se usa en emails y PDFs.</p>
                <ImageUploadField value={theme.assets.logoOnLight ?? ''} onChange={(url) => setAssets({ logoOnLight: url })} prefix="brand" fit="contain" previewClassName="bg-white" accept="image/png,image/jpeg" label="logo para fondos claros" />
              </div>
              <div>
                <Label>Icono de la pestaña (favicon)</Label>
                <p className="mb-2 text-xs text-muted-foreground">Cuadrado, PNG.</p>
                <ImageUploadField value={theme.assets.favicon ?? ''} onChange={(url) => setAssets({ favicon: url })} prefix="brand" fit="contain" accept="image/png,image/jpeg" label="icono de la pestaña" />
              </div>
              <div>
                <Label>Imagen para redes sociales</Label>
                <p className="mb-2 text-xs text-muted-foreground">Al compartir un enlace. 1200 × 630.</p>
                <ImageUploadField value={theme.assets.ogImage ?? ''} onChange={(url) => setAssets({ ogImage: url })} prefix="brand" accept="image/png,image/jpeg" label="imagen para redes sociales" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">Sin logo, la web muestra el nombre como marca de texto. Los PDFs y los pases de wallet necesitan un logo en PNG o JPEG.</p>
          </CardContent></Card>
        </div>

        <aside className="space-y-4 xl:sticky xl:top-6 xl:self-start">
          <h2 className="font-display text-lg font-semibold">Vista previa</h2>
          <Preview theme={theme} mode="dark" />
          <Preview theme={theme} mode="light" />
          <p className="text-xs text-muted-foreground">
            El texto, los bordes y las tarjetas se calculan a partir de tus colores para que siempre se lean bien.
            {` Tono principal: ${Math.round(hexToHsl(theme.colors.primary).h)}°.`}
          </p>
        </aside>
      </div>
    </div>
  );
}
