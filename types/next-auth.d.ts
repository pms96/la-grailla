import { DefaultSession, DefaultUser } from 'next-auth';
import { DefaultJWT } from 'next-auth/jwt';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      role: string;
      /** Módulos que puede administrar (roles por módulo). null = sin restricción (propietario). */
      modules?: string[] | null;
    } & DefaultSession['user'];
  }
  interface User extends DefaultUser {
    role: string;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id: string;
    role: string;
    /** Cuándo se inició la sesión (ms): permite revocar las anteriores a User.sessionsValidAfter. */
    sia?: number;
    /** Módulos del rol al iniciar sesión (undefined = propietario): el middleware, sin BD, corta rutas con esto. */
    mods?: string[];
    /** Clave de esos permisos (modulesKey): si en la BD cambia, la sesión deja de valer. */
    mk?: string;
  }
}
