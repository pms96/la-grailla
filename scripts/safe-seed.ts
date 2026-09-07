import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { isLocalDatabaseUrl } from "./is-local-database-url";

// El seed borra y recrea filas de prueba (eventos, entradas, pedidos...) —
// ejecutarlo sin querer contra la base de datos de producción destruiría
// datos reales. Solo se permite sin el override explícito cuando el host de
// DATABASE_URL es la base de datos local de desarrollo.
if (!isLocalDatabaseUrl(process.env.DATABASE_URL ?? "") && process.env.ALLOW_PROD_SEED !== "1") {
  console.error("Seed aborted: DATABASE_URL no apunta a localhost/127.0.0.1.");
  console.error("Sembrar datos de prueba contra una base de datos remota puede borrar datos reales.");
  console.error("Si de verdad quieres sembrar esa base de datos, repite el comando con ALLOW_PROD_SEED=1.");
  process.exit(1);
}

try {
  const seedFile = path.resolve(process.cwd(), "scripts/seed.ts");
  const content = fs.readFileSync(seedFile, "utf-8");

  const forbiddenPatterns = [
    /prisma\.\w+\.delete\(/,
    /prisma\.\w+\.deleteMany\(/,
  ];

  const violations = forbiddenPatterns.filter((pattern) => pattern.test(content));

  if (violations.length > 0) {
    console.error("Seed aborted: seed.ts contains prisma.delete or prisma.deleteMany calls.");
    console.error("Remove all delete operations before seeding to avoid deleting production data.");
    console.error("Do not modify this file to bypass this check in development environment as production and deployment database can be shared.");
    process.exit(1);
  }

} catch (err: any) {
}

execSync("tsx --require dotenv/config scripts/seed.ts", { stdio: "inherit" });