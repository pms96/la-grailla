export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { handleApiError } from '@/lib/api-error';
import { prisma } from '@/lib/prisma';
import { THEME_CONFIG_KEY, getEditableTheme } from '@/lib/brand/brand';
import { LEGACY_FIXED_ASSETS, parseTheme, themeContrastIssues, themeSchema, type SiteTheme } from '@/lib/brand/theme';
import { isBlobUrlUnder, parseBlobUrl } from '@/lib/blob-url';
import { tenantBlobPrefix } from '@/lib/tenant/blob';
import { isLegacyTenant } from '@/lib/tenant/context';

/* Apariencia (tema de marca del cliente). Solo ADMIN. El tema se valida con el mismo esquema que se usa al leer, y los recursos
 * (logos, favicon, imagen social) tienen que ser ficheros DE ESTE cliente: en modo plataforma, de su prefijo en Blob. */

function assetBelongsToTenant(url: string): boolean {
  // Los ficheros /brand/… son de la instalación de La Grailla.
  if (url.startsWith('/brand/') || (LEGACY_FIXED_ASSETS as readonly string[]).includes(url)) return isLegacyTenant();
  if (!parseBlobUrl(url)) return false;
  const prefix = tenantBlobPrefix().replace(/\/$/, '');
  return prefix === '' || isBlobUrlUnder(url, prefix);
}

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return session?.user?.role === 'ADMIN';
}

export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    return NextResponse.json(await getEditableTheme());
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/theme');
  }
}

export async function PUT(request: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    const parsed = themeSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Datos de apariencia no válidos', details: parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)) }, { status: 400 });
    }
    const theme: SiteTheme = parsed.data;

    for (const [field, url] of Object.entries(theme.assets)) {
      if (url && !assetBelongsToTenant(url)) {
        return NextResponse.json({ error: `La imagen «${field}» no es un fichero de este sitio. Vuelve a subirla.` }, { status: 400 });
      }
    }
    const issues = themeContrastIssues(theme);
    if (issues.length > 0) {
      return NextResponse.json({ error: 'Con esos colores el texto no se leería bien.', details: issues }, { status: 422 });
    }

    // Lo que se guarda es lo ya validado y normalizado, nunca el cuerpo tal cual.
    const value = JSON.stringify(parseTheme(theme));
    await prisma.appConfig.upsert({
      where: { key: THEME_CONFIG_KEY },
      update: { value },
      create: { key: THEME_CONFIG_KEY, value, label: 'Tema de marca', group: 'brand' },
    });
    // En una instalación única las páginas estáticas se regeneran; en modo plataforma todo es dinámico.
    revalidatePath('/', 'layout');
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, 'PUT /api/admin/theme');
  }
}

/** Vuelve a la apariencia por defecto (en La Grailla, la original; en otros clientes, la neutra). */
export async function DELETE() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  try {
    await prisma.appConfig.deleteMany({ where: { key: THEME_CONFIG_KEY } });
    revalidatePath('/', 'layout');
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, 'DELETE /api/admin/theme');
  }
}
