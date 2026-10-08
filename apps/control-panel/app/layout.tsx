import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { currentSession } from '@/lib/guard';
import { can } from '@/lib/permissions';
import { logoutAction } from './actions/auth';
import './globals.css';

export const metadata: Metadata = { title: 'Control · La Grailla', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: ReactNode }) {
  const live = await currentSession();
  const full = live?.mfaVerified && !live.operator.mustChangePassword ? live : null;
  return (
    <html lang="es">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">
            La Grailla <span>Control</span>
          </Link>
          {full && (
            <>
              <nav aria-label="Principal">
                <Link href="/">Clientes</Link>
                <Link href="/audit">Auditoría</Link>
                {can(full.operator.role, 'operators:manage') && <Link href="/operators">Operadores</Link>}
              </nav>
              <div className="who">
                <span>
                  {full.operator.email} · {full.operator.role.toLowerCase()}
                </span>
                <form action={logoutAction}>
                  <button className="btn quiet" type="submit">
                    Salir
                  </button>
                </form>
              </div>
            </>
          )}
        </header>
        {children}
      </body>
    </html>
  );
}
