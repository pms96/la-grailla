import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

/* Revisión integral, lote 10 (seguridad general): H-108 (Postgres de desarrollo), H-109 (.gitignore), H-110 (dependencias sin uso), H-112 (CSP), H-114 (acciones por SHA). */

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('H-108: el Postgres de desarrollo solo escucha en este equipo', () => {
  it('el puerto se publica en 127.0.0.1 (sus credenciales son conocidas: lagrailla/lagrailla)', () => {
    const ports = [...read('docker-compose.yml').matchAll(/^\s*-\s*['"]?([^'"\n]*\d+:\d+)['"]?\s*$/gm)].map((m) => m[1]);
    expect(ports.length).toBeGreaterThan(0);
    for (const p of ports) expect(p, p).toMatch(/^127\.0\.0\.1:\d+:\d+$/);
  });
});

describe('H-109: .gitignore', () => {
  /** Lo que git ignoraría de verdad (usa las reglas reales del repositorio). */
  const ignored = (file: string) => {
    try {
      execFileSync('git', ['check-ignore', '-q', '--no-index', file], { cwd: ROOT }); // --no-index: también para lo que ya está versionado
      return true;
    } catch {
      return false;
    }
  };

  it('cualquier .env.<algo> queda fuera (un `vercel env pull .env.production` + `git add .` no sube claves) y solo la plantilla se versiona', () => {
    for (const f of ['.env', '.env.production', '.env.staging', '.env.test', '.env.development.local', 'apps/control-panel/.env.production']) expect(ignored(f), f).toBe(true);
    for (const f of ['.env.example', 'apps/control-panel/.env.example']) expect(ignored(f), f).toBe(false);
  });

  it('los certificados y claves privadas (el de Apple Wallet es un .p12) quedan fuera', () => {
    for (const f of ['cert.p12', 'wallet/apple.p12', 'x.pfx', 'x.key', 'x.pem', 'apps/control-panel/signing.key']) expect(ignored(f), f).toBe(true);
  });

  it('no hay ya versionado ningún archivo de entorno que no sea la plantilla, ni certificados', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
    const risky = tracked.filter((f) => /(^|\/)\.env(\..+)?$/.test(f) && !f.endsWith('.env.example')).concat(tracked.filter((f) => /\.(p12|pfx|key|pem|jks|keystore)$/i.test(f)));
    expect(risky).toEqual([]);
  });
});

describe('H-114: acciones de GitHub fijadas por SHA', () => {
  const dir = path.join(ROOT, '.github/workflows');
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));

  it('toda `uses:` de un workflow apunta a un commit (40 hex) y no a una etiqueta que el autor pueda mover', () => {
    const uses = files.flatMap((f) => [...read(`.github/workflows/${f}`).matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => ({ f, ref: m[1] })));
    expect(uses.length).toBeGreaterThan(0);
    for (const { f, ref } of uses) {
      if (ref.startsWith('./')) continue; // acción del propio repositorio
      expect(ref, `${f}: ${ref}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    }
  });

  it('Dependabot vigila las acciones (un SHA fijo no se entera solo de los parches de seguridad)', () => {
    expect(read('.github/dependabot.yml')).toMatch(/package-ecosystem:\s*github-actions/);
  });
});

describe('H-110: dependencias de producción sin ningún import', () => {
  const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> };
  /** Cargadas sin `import` explícito en el código (configuración, par de otra librería…). Cada una con su motivo. */
  const IMPLICIT: Record<string, string> = {
    autoprefixer: 'postcss.config.js lo carga por nombre',
    'react-is': 'par de recharts (peerDependencies); fijado a la 18 para que no instale otra',
    react: 'runtime',
    'react-dom': 'runtime',
    '@next/swc-wasm-nodejs': 'binario alternativo de Next',
    '@prisma/client': 'cliente generado por prisma',
  };

  it('toda dependencia declarada se importa en algún archivo del repositorio (o está en la lista de implícitas, con motivo)', () => {
    const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs|json)$/.test(f) && !/(^|\/)package(-lock)?\.json$/.test(f) && !f.startsWith('docs/') && !f.startsWith('doc/'));
    const corpus = files.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
    const imported = (name: string) => new RegExp(`['"\`]${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(['"\`/])`).test(corpus);
    const unused = Object.keys(pkg.dependencies).filter((name) => {
      if (name in IMPLICIT) return false;
      // `@types/foo` vale si se importa `foo` (o `@scope/foo` en los de paquetes con ámbito).
      if (name.startsWith('@types/')) return !imported(name.slice('@types/'.length).replace('__', '/'));
      return !imported(name);
    });
    expect(unused, 'quita estas dependencias de package.json (o añádelas a IMPLICIT con su motivo)').toEqual([]);
  });

  it('las que se quitaron en H-110 no vuelven a declararse', () => {
    for (const name of ['@floating-ui/react', '@headlessui/react', '@hookform/resolvers', '@tanstack/react-query', 'chart.js', 'react-chartjs-2', 'dayjs', 'formik', 'yup', 'google-auth-library', 'gray-matter', 'jotai', 'lodash', 'react-datepicker', 'react-intersection-observer', 'react-use', 'swr', 'zustand', 'tailwind-scrollbar-hide', '@types/stripe', '@types/uuid', 'webpack', 'cookie', 'csv', 'react-hot-toast', 'react-select']) {
      expect(pkg.dependencies, name).not.toHaveProperty(name);
    }
  });
});

describe('H-112: la CSP solo admite el almacén de Blob de este despliegue', () => {
  const WILDCARD = 'https://*.public.blob.vercel-storage.com';
  const saved = process.env.BLOB_PUBLIC_HOST;
  afterEach(() => {
    if (saved === undefined) delete process.env.BLOB_PUBLIC_HOST;
    else process.env.BLOB_PUBLIC_HOST = saved;
  });

  async function csp(host: string | undefined): Promise<string> {
    if (host === undefined) delete process.env.BLOB_PUBLIC_HOST;
    else process.env.BLOB_PUBLIC_HOST = host;
    const req = createRequire(import.meta.url);
    delete req.cache[req.resolve('../../next.config.js')]; // next.config.js lee la variable al cargarse
    const cfg = req('../../next.config.js') as { headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> };
    const all = await cfg.headers();
    return all.find((r) => r.source === '/:path*')!.headers.find((h) => h.key === 'Content-Security-Policy')!.value;
  }
  const directive = (policy: string, name: string) => policy.split('; ').find((d) => d.startsWith(`${name} `)) ?? '';

  it('con BLOB_PUBLIC_HOST, img-src, media-src y connect-src llevan ESE host y ningún comodín', async () => {
    const policy = await csp('abc123.public.blob.vercel-storage.com');
    for (const d of ['img-src', 'media-src', 'connect-src']) {
      expect(directive(policy, d), d).toContain('https://abc123.public.blob.vercel-storage.com');
      expect(directive(policy, d), d).not.toContain('*');
    }
    expect(policy).not.toContain(WILDCARD);
  });

  it('sin BLOB_PUBLIC_HOST (el despliegue antiguo) se conserva el comodín, que es lo que usaba', async () => {
    const policy = await csp(undefined);
    for (const d of ['img-src', 'media-src', 'connect-src']) expect(directive(policy, d), d).toContain(WILDCARD);
  });

  it('un valor mal formado no abre la política: se ignora y queda el comodín de siempre (no un host inventado)', async () => {
    const policy = await csp('https://evil.example.com/');
    expect(policy).not.toContain('evil.example.com');
    expect(directive(policy, 'img-src')).toContain(WILDCARD);
  });

  it('el resto de la política no cambia (scripts, frames, formularios, object-src)', async () => {
    const policy = await csp('abc123.public.blob.vercel-storage.com');
    expect(directive(policy, 'script-src')).toContain('https://challenges.cloudflare.com');
    expect(directive(policy, 'object-src')).toBe("object-src 'none'");
    expect(directive(policy, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(policy, 'form-action')).toBe("form-action 'self'");
  });
});
