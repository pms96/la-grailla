'use client';

import { useState, type ComponentType } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession, signOut } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { Logo } from '@/components/logo';
import { cn } from '@/lib/utils';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ChangePasswordDialog } from '@/app/admin/_components/change-password-dialog';
import {
  LayoutDashboard, Calendar, Ticket, Users, ShoppingBag, Package,
  BarChart3, Handshake, Settings, LogOut, Menu, X, QrCode, KeyRound, Receipt, Moon,
  UserPlus, ScanLine, Gauge,
} from 'lucide-react';

type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  exact?: boolean;
  highlight?: boolean;
};

type NavGroup = {
  label?: string;
  items: NavItem[];
};

const navGroups: NavGroup[] = [
  {
    items: [
      { href: '/admin', label: 'Dashboard', icon: LayoutDashboard, exact: true },
      { href: '/admin/noche', label: 'Modo noche', icon: Moon, highlight: true },
    ],
  },
  {
    label: 'Eventos',
    items: [
      { href: '/admin/eventos', label: 'Eventos', icon: Calendar },
      { href: '/admin/entradas', label: 'Tipos de entrada', icon: Ticket },
      { href: '/admin/invitaciones', label: 'Invitaciones', icon: UserPlus },
      { href: '/admin/ventas', label: 'Ventas', icon: Receipt },
    ],
  },
  {
    label: 'Operaciones',
    items: [
      { href: '/admin/aforo', label: 'Aforo', icon: Gauge },
      { href: '/admin/escaneos', label: 'Escaneos', icon: ScanLine },
      { href: '/admin/estadisticas', label: 'Estadísticas', icon: BarChart3 },
    ],
  },
  {
    label: 'Tienda',
    items: [
      { href: '/admin/productos', label: 'Productos', icon: ShoppingBag },
      { href: '/admin/pedidos', label: 'Pedidos tienda', icon: Package },
    ],
  },
  {
    label: 'Sistema',
    items: [
      { href: '/admin/sponsors', label: 'Patrocinios', icon: Handshake },
      { href: '/admin/usuarios', label: 'Usuarios', icon: Users },
      { href: '/admin/configuracion', label: 'Configuración', icon: Settings },
    ],
  },
];

function NavLink({
  item,
  pathname,
  onNavigate,
}: {
  item: NavItem;
  pathname: string;
  onNavigate: () => void;
}) {
  const isActive = item.exact ? pathname === item.href : pathname.startsWith(item.href);
  return (
    <Link href={item.href} onClick={onNavigate}>
      <Button
        variant={isActive ? 'secondary' : item.highlight ? 'default' : 'ghost'}
        className="w-full justify-start gap-2 text-sm"
        size="sm"
      >
        <item.icon className="h-4 w-4" />
        {item.label}
      </Button>
    </Link>
  );
}

export default function AdminShell({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession() || {};
  const pathname = usePathname() ?? '';
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const closeSidebar = () => setSidebarOpen(false);

  return (
    <div className="min-h-screen flex">
      <aside className={cn(
        'fixed inset-y-0 left-0 z-50 w-64 bg-card border-r border-border transform transition-transform md:translate-x-0 md:static',
        sidebarOpen ? 'translate-x-0' : '-translate-x-full'
      )}>
        <div className="flex flex-col h-full">
          <div className="p-4 border-b border-border">
            <div className="flex items-center justify-between">
              <Link href="/admin" className="flex items-center gap-2">
                <Logo variant="white" className="h-7" />
              </Link>
              <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={closeSidebar}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">Panel de administración</p>
          </div>

          <nav className="flex-1 p-3 space-y-4 overflow-y-auto">
            {navGroups.map((group, gi) => (
              <div key={group.label ?? `g-${gi}`} className="space-y-1">
                {group.label && (
                  <p className="px-2 pt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground/80">
                    {group.label}
                  </p>
                )}
                {group.items.map((item) => (
                  <NavLink key={item.href} item={item} pathname={pathname} onNavigate={closeSidebar} />
                ))}
              </div>
            ))}
            <div className="pt-2 border-t border-border">
              <Link href="/acceso" onClick={closeSidebar}>
                <Button variant="ghost" className="w-full justify-start gap-2 text-sm" size="sm">
                  <QrCode className="h-4 w-4" /> Escáner QR
                </Button>
              </Link>
            </div>
          </nav>

          <div className="p-3 border-t border-border">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex w-full items-center gap-2 rounded-md p-1.5 text-left transition-colors hover:bg-accent">
                  <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">
                    {(session?.user?.name ?? 'A')?.[0]?.toUpperCase?.() ?? 'A'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{session?.user?.name ?? 'Admin'}</p>
                    <p className="text-xs text-muted-foreground truncate">{session?.user?.email ?? ''}</p>
                  </div>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuItem className="gap-2" onSelect={() => setChangePasswordOpen(true)}>
                  <KeyRound className="h-4 w-4" /> Cambiar contraseña
                </DropdownMenuItem>
                <DropdownMenuItem className="gap-2 text-destructive" onSelect={() => signOut?.({ callbackUrl: '/auth/login' })}>
                  <LogOut className="h-4 w-4" /> Cerrar sesión
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <ChangePasswordDialog open={changePasswordOpen} onOpenChange={setChangePasswordOpen} />
        </div>
      </aside>

      {sidebarOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={closeSidebar} />
      )}

      <div className="flex-1 min-w-0">
        <header className="sticky top-0 z-30 bg-background/95 backdrop-blur border-b border-border md:hidden">
          <div className="flex items-center gap-3 px-4 h-14">
            <Button variant="ghost" size="icon-sm" onClick={() => setSidebarOpen(true)}>
              <Menu className="h-5 w-5" />
            </Button>
            <Logo variant="white" className="h-6" />
          </div>
        </header>
        <main className="p-4 md:p-6 lg:p-8 max-w-[1200px]">
          {children}
        </main>
      </div>
    </div>
  );
}
