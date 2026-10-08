'use client';

import { useFormState, useFormStatus } from 'react-dom';
import type { ReactNode } from 'react';

export type ActionState = {
  error?: string;
  ok?: string;
  // Datos que se muestran una sola vez tras la acción (contraseña temporal, códigos de recuperación).
  reveal?: { title: string; lines: string[]; note?: string };
};

export type FormAction = (prev: ActionState, formData: FormData) => Promise<ActionState>;

function Submit({ label, tone }: { label: string; tone?: 'danger' | 'quiet' }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={`btn ${tone ?? ''}`} disabled={pending} aria-busy={pending}>
      {pending ? 'Procesando…' : label}
    </button>
  );
}

export function ActionForm({
  action,
  submitLabel,
  tone,
  children,
  className,
  confirm,
}: {
  action: FormAction;
  submitLabel: string;
  tone?: 'danger' | 'quiet';
  children?: ReactNode;
  className?: string;
  confirm?: string;
}) {
  const [state, formAction] = useFormState(action, {});
  return (
    <form
      action={formAction}
      className={className ?? 'stack'}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children}
      {state.error && (
        <p className="msg error" role="alert">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p className="msg ok" role="status">
          {state.ok}
        </p>
      )}
      {state.reveal && (
        <div className="reveal" role="status">
          <strong>{state.reveal.title}</strong>
          <pre>{state.reveal.lines.join('\n')}</pre>
          {state.reveal.note && <p className="muted">{state.reveal.note}</p>}
        </div>
      )}
      <Submit label={submitLabel} tone={tone} />
    </form>
  );
}
