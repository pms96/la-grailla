/** En desarrollo local (`*.localhost`, `*.test`) no hay HTTPS: ni cookies __Secure- ni URLs https. */
export function isDevHost(host: string): boolean {
  const hostname = host.toLowerCase().replace(/:\d{1,5}$/, '');
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.test');
}
