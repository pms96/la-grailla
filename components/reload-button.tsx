'use client';

import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';

export function ReloadButton({
  label = 'Reintentar',
  variant = 'default',
  className,
}: {
  label?: string;
  variant?: 'default' | 'outline' | 'secondary' | 'ghost';
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant={variant}
      className={className}
      onClick={() => window.location.reload()}
    >
      <RefreshCw className="h-4 w-4" />
      {label}
    </Button>
  );
}
