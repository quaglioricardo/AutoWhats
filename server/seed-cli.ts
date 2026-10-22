import "dotenv/config";
import { migrate, pool } from "./db.js";
import { seedIfEmpty } from "./seed.js";

await migrate();
const seeded = await seedIfEmpty();
console.log(seeded ? "Catálogo de exemplo carregado." : "O catálogo já tem produtos; nada foi alterado.");
await pool.end();
