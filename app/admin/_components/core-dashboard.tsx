import Link from 'next/link';
import { Coins, Handshake, MessageSquare, Palette, Settings, ShoppingCart, Users, Wallet, type LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { prisma } from '@/lib/prisma';
import { getBrand, hasSavedTheme } from '@/lib/brand/brand';
import { isContactFormEnabled } from '@/lib/contact';
import { pathAllowedForModules } from '@/lib/modules/access';
import { isLinkVisible } from '@/lib/modules/registry';

/* Panel de inicio del núcleo: para quien no tiene a mano ni Entradas ni Tienda (un cliente sin ellas, o un usuario con un rol de otro módulo).
 * Lo que hay que hacer primero (marca, contacto), lo pendiente (mensajes sin responder) y accesos a SUS módulos: cada acceso sale solo si el
 * módulo está activo en el cliente y el rol del usuario lo permite (los mismos criterios que el menú y el servidor). */

type Entry = { href: string; icon: LucideIcon; title: string; text: string; highlight?: boolean };

export default async function CoreDashboard({ modules, userModules }: { modules: Parameters<typeof isLinkVisible>[1]; userModules: readonly string[] | null }) {
  const [brand, themed, contactOn, unanswered] = await Promise.all([
    getBrand(),
    hasSavedTheme(),
    isContactFormEnabled(),
    prisma.contactMessage.count({ where: { status: 'NEW' } }).catch(() => 0),
  ]);
  const entries: Entry[] = [
    { href: '/admin/mensajes', icon: MessageSquare, title: 'Mensajes', text: unanswered > 0 ? `${unanswered} sin responder` : contactOn ? 'Al día' : 'El formulario de contacto está oculto', highlight: unanswered > 0 },
    { href: '/admin/apariencia', icon: Palette, title: 'Apariencia', text: themed ? 'Logo, colores y textos de tu web' : 'Personaliza tu web: logo, colores y textos', highlight: !themed },
    { href: '/admin/compras', icon: ShoppingCart, title: 'Compras', text: 'Proveedores, artículos y pedidos' },
    { href: '/admin/gastos', icon: Wallet, title: 'Gastos', text: 'Contabilidad real de lo que se ha gastado' },
    { href: '/admin/ingresos', icon: Coins, title: 'Ingresos', text: 'Lo que ha entrado fuera de las ventas online' },
    { href: '/admin/sponsors', icon: Handshake, title: 'Sponsors', text: 'Portal de sponsors y su pipeline' },
    { href: '/admin/usuarios', icon: Users, title: 'Usuarios', text: 'Quién puede entrar al panel' },
    { href: '/admin/configuracion', icon: Settings, title: 'Configuración', text: 'Contenido, email y textos legales' },
  ];
  const links = entries.filter((e) => isLinkVisible(e.href, modules) && pathAllowedForModules(e.href, userModules));
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight md:text-3xl">Dashboard</h1>
        <p className="mt-1 text-muted-foreground">Panel de {brand.name}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {links.map((l) => (
          <Link key={l.href} href={l.href} className="group rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Card className={l.highlight ? 'border-primary/40 bg-primary/5' : undefined}>
              <CardContent className="flex items-start gap-3 p-5">
                <l.icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
                <div>
                  <p className="font-display font-semibold group-hover:text-primary">{l.title}</p>
                  <p className="text-sm text-muted-foreground">{l.text}</p>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
