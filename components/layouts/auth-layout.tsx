import { cn } from '@/lib/utils'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Logo } from '@/components/logo'

export function AuthLayout({
  title,
  description,
  children,
  className,
  variant = 'festive',
}: {
  title: string
  description?: string
  children: React.ReactNode
  className?: string
  /** festive = web pública; sober = panel staff */
  variant?: 'festive' | 'sober'
}) {
  const isSober = variant === 'sober'

  return (
    <div
      className={cn(
        'min-h-screen flex items-center justify-center p-4 relative',
        isSober ? 'bg-background' : 'hero-gradient'
      )}
    >
      {!isSober && <div className="absolute inset-0 texture-noise" />}
      <Card
        className={cn(
          'w-full max-w-md relative',
          isSober ? 'border border-border shadow-sm' : 'shadow-lg border-2 border-border/50',
          className
        )}
      >
        <CardHeader className="text-center">
          <div className="flex justify-center mb-2">
            <Logo variant="white" className="h-10" priority />
          </div>
          <CardTitle className="font-display text-2xl tracking-tight">{title}</CardTitle>
          {description && (
            <CardDescription className="text-sm text-muted-foreground">{description}</CardDescription>
          )}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  )
}
