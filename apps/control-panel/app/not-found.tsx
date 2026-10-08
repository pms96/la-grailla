import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="auth">
      <h1>No encontrado</h1>
      <p className="muted">Esa página o ese cliente no existe.</p>
      <Link href="/">Volver a Clientes</Link>
    </main>
  );
}
