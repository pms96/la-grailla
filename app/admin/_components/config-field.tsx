'use client';

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
  return (
    <div className={className}>
      <Label>{label}</Label>
      {type === 'textarea' ? (
        <Textarea value={value ?? ''} onChange={(e) => onChange(e.target.value)} className="mt-1" rows={rows} placeholder={placeholder} />
      ) : (
        <Input
          type={type}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1"
          placeholder={placeholder}
        />
      )}
      {description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
    </div>
  );
}
