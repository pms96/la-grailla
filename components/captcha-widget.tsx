'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

/* Widget del captcha (Cloudflare Turnstile). Solo se monta si el cliente tiene el captcha activado (la página le pasa su clave pública); sin clave
 * no se pinta este componente y no se descarga nada de Cloudflare.
 *
 *  - Modo `interaction-only`: invisible salvo que Cloudflare necesite un reto. La mayoría de compradores no ven nada.
 *  - Un token vale UNA vez y caduca a los ~5 min: tras cada intento de envío hay que pedir otro con `reset()`; si caduca esperando, avisa con `null`.
 *  - Si el script no carga (bloqueador de anuncios, red), se dice claro y se puede reintentar: sin token el servidor no deja continuar. */

type TurnstileApi = {
  render: (el: HTMLElement, options: Record<string, unknown>) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let scriptPromise: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (typeof window === 'undefined') return Promise.reject(new Error('sin navegador'));
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptPromise ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile no disponible')));
    script.onerror = () => reject(new Error('no se pudo cargar turnstile'));
    document.head.appendChild(script);
  }).catch((error) => {
    scriptPromise = null; // permite reintentar
    throw error;
  });
  return scriptPromise;
}

export type CaptchaWidgetHandle = {
  /** Pide un token nuevo (el anterior ya se gastó o caducó). */
  reset: () => void;
};

type Props = {
  siteKey: string;
  /** Acción que el servidor comprueba (`order`, `shop-order`, `queue`): un token no vale para otra. */
  action: 'order' | 'shop-order' | 'queue';
  /** Token listo, o null cuando caduca o falla. */
  onToken: (token: string | null) => void;
  /** El widget no puede funcionar (script bloqueado o caído, error del propio widget): quien lo usa decide cómo seguir (enviar sin token y que mande el servidor). */
  onUnavailable?: () => void;
  className?: string;
};

export const CaptchaWidget = forwardRef<CaptchaWidgetHandle, Props>(function CaptchaWidget({ siteKey, action, onToken, onUnavailable, className }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useImperativeHandle(ref, () => ({
    reset: () => {
      onTokenRef.current(null);
      if (widgetIdRef.current && window.turnstile) window.turnstile.reset(widgetIdRef.current);
    },
  }));

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    loadTurnstile()
      .then((api) => {
        if (cancelled || !containerRef.current) return;
        widgetIdRef.current = api.render(containerRef.current, {
          sitekey: siteKey,
          action,
          appearance: 'interaction-only',
          theme: 'auto',
          language: 'es',
          callback: (token: string) => onTokenRef.current(token),
          'expired-callback': () => onTokenRef.current(null),
          'timeout-callback': () => onTokenRef.current(null),
          'error-callback': () => {
            onTokenRef.current(null);
            // H-094: además de avisar a quien lo usa, se muestra el aviso con «Reintentar». Antes, tras el único intento «a ciegas» el comprador quedaba en
            // «Una comprobación rápida» con un hueco vacío, sin error ni forma de reintentar.
            setFailed(true);
            onUnavailableRef.current?.();
            return true;
          },
        });
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        onUnavailableRef.current?.();
      });
    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) window.turnstile.remove(widgetIdRef.current);
      widgetIdRef.current = null;
    };
  }, [siteKey, action, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return (
    <div className={className}>
      <div ref={containerRef} />
      {failed && (
        <p role="alert" className="text-sm text-muted-foreground">
          No hemos podido cargar la comprobación de seguridad. Si usas un bloqueador de anuncios, desactívalo para esta web.{' '}
          <button type="button" onClick={retry} className="underline underline-offset-2">
            Reintentar
          </button>
        </p>
      )}
    </div>
  );
});
