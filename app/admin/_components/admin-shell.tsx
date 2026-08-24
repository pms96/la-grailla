'use client';

import { useState } from 'react';
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
  BarChart3, Handshake, Settings, LogOut, Menu, X, QrCode, KeyRound
} from 'lucide-react';

const navItems = [
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { href: '/admin/eventos', label: 'Eventos', icon: Calendar },
  { href: '/admin/entradas', label: 'Entradas', icon: Ticket },
  { href: '/admin/aforo', label: 'Aforo', icon: Users },
  { href: '/admin/productos', label: 'Productos', icon: ShoppingBag },
  { href: '/admin/pedidos', label: 'Pedidos Tienda', icon: Package },
  { href: '/admin/estadisticas', label: 'Estadísticas', icon: BarChart3 },
  { href: '/admin/sponsors', label: 'Sponsors', icon: Handshake },
  { href: '/admin/usuarios', label: 'Usuarios', icon: Users },
  { href: '/admin/configuracion', label: 'Configuración', icon: Settings },
];

export default function AdminShell({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession() || {};
  const pathname = usePathname() ?? '';
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
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
              <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={() => setSidebarOpen(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">Panel de Administración</p>
          </div>

          <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
            {navItems.map((item) => {
              const isActive = item?.exact ? pathname === item.href : pathname?.startsWith(item.href);
              return (
                <Link key={item.href} href={item.href} onClick={() => setSidebarOpen(false)}>
                  <Button
                    variant={isActive ? 'secondary' : 'ghost'}
                    className="w-full justify-start gap-2 text-sm"
                    size="sm"
                  >
                    <item.icon className="h-4 w-4" />
                    {item.label}
                  </Button>
                </Link>
              );
            })}
            <div className="pt-2 border-t border-border mt-2">
              <Link href="/acceso" onClick={() => setSidebarOpen(false)}>
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

      {/* Overlay for mobile */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Main content */}
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
