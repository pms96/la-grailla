import { assertLocalTestDatabase } from '../helpers/require-local-db';

// Se ejecuta antes de cada fichero de test (ver `setupFiles` en vitest.config.mts, DESPUÉS de dotenv/config para ver ya lo que carga el .env).
// Si la base de datos no es local, el fichero entero falla antes de tocar nada.
assertLocalTestDatabase();
