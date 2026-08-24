import { cn } from '@/lib/utils'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Logo } from '@/components/logo'

export function AuthLayout({
  title,
  description,
  children,
  className,
}: {
  title: string
  description?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4 hero-gradient relative">
      <div className="absolute inset-0 texture-noise" />
      <Card className={cn('w-full max-w-md shadow-lg border-2 border-border/50 relative', className)}>
        <CardHeader className="text-center">
          <div className="flex justify-center mb-2">
            <Logo variant="white" className="h-10" priority />
          </div>
          <CardTitle className="font-display text-2xl tracking-tight">{title}</CardTitle>
          {description && (
            <CardDescription className="text-sm text-muted-foreground">{description}</CardDescription>
          )}
        </CardHeader>
        <CardContent>
          {children}
        </CardContent>
      </Card>
    </div>
  )
}
