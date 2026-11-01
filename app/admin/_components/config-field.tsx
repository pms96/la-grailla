'use client';

import { useId } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

type ConfigFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  description?: string;
  placeholder?: string;
  type?: 'text' | 'password' | 'number' | 'textarea';
  rows?: number;
  className?: string;
};

export function ConfigField({ label, value, onChange, description, placeholder, type = 'text', rows = 3, className }: ConfigFieldProps) {
  // La etiqueta se asocia al campo: sin esto un lector de pantalla anuncia un cuadro de texto sin nombre.
  const id = useId();
  return (
    <div className={className}>
      <Label htmlFor={id}>{label}</Label>
      {type === 'textarea' ? (
        <Textarea id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)} className="mt-1" rows={rows} placeholder={placeholder} />
      ) : (
        <Input
          id={id}
          type={type}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1"
          placeholder={placeholder}
          // H-095: ni el navegador ni un gestor de contraseñas rellenan estos campos con credenciales ajenas (la contraseña del propio administrador acababa guardada
          // como clave secreta de la pasarela). `new-password` es lo que Chrome respeta; los `data-*` son los de 1Password, LastPass y Bitwarden.
          autoComplete={type === 'password' ? 'new-password' : 'off'}
          data-1p-ignore
          data-lpignore="true"
          data-bwignore="true"
        />
      )}
      {description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
    </div>
  );
}
