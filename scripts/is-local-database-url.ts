const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

export function isLocalDatabaseUrl(databaseUrl: string): boolean {
  try {
    return LOCAL_HOSTS.includes(new URL(databaseUrl).hostname);
  } catch {
    return false;
  }
}
