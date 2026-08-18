'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Cookie, X } from 'lucide-react';

const STORAGE_KEY = 'lagrailla_cookie_consent';

export default function CookieBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (!window.localStorage.getItem(STORAGE_KEY)) setVisible(true);
    } catch {}
  }, []);

  const decide = (value: 'all' | 'essential') => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ value, date: new Date().toISOString() }));
    } catch {}
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 p-3 sm:p-4">
      <div className="mx-auto max-w-4xl rounded-2xl border border-border/60 bg-background/95 backdrop-blur shadow-2xl p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-3">
            <Cookie className="h-5 w-5 shrink-0 text-primary mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold leading-tight">Usamos cookies</p>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Utilizamos cookies propias necesarias para el funcionamiento de la web y, con tu permiso, cookies de
                analítica para mejorar la experiencia. Puedes consultar más detalles en la{' '}
                <Link href="/legal/cookies" className="underline underline-offset-2 hover:text-foreground">
                  política de cookies
                </Link>
                .
              </p>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" onClick={() => decide('essential')}>
              Solo esenciales
            </Button>
            <Button size="sm" onClick={() => decide('all')}>
              Aceptar todas
            </Button>
            <button
              type="button"
              aria-label="Cerrar aviso de cookies"
              onClick={() => decide('essential')}
              className="sm:hidden inline-flex items-center justify-center rounded-md p-2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
