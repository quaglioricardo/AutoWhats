import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { migrate, pool } from "./server/db.js";
import { seedIfEmpty } from "./server/seed.js";
import {
  createProduct,
  deleteProduct,
  getSettings,
  listProducts,
  updateProduct,
  updateSettings,
  upsertProducts,
  validateProduct,
  ValidationError,
} from "./server/catalog.js";
import { productsFromCsv, productsFromPostgres } from "./server/importers.js";
import { chat, diagnoseAi, startConversation } from "./server/ai.js";

if (process.env.NODE_ENV === "production") {
  const missing = ["DATABASE_URL", "ANTHROPIC_API_KEY"].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Variáveis de ambiente faltando: ${missing.join(", ")}. Configure-as e reinicie.`);
    process.exit(1);
  }
  if (!process.env.APP_PASSWORD) console.warn("Aviso: APP_PASSWORD vazio, o painel está aberto a qualquer pessoa.");
}

process.on("unhandledRejection", (err) => console.error("Erro não tratado:", err));
process.on("uncaughtException", (err) => {
  console.error("Exceção não tratada:", err);
  process.exit(1);
});

const app = express();
app.use(express.json({ limit: "5mb" }));

// The panel controls the catalog and spends API credits, so protect it when published.
const password = process.env.APP_PASSWORD;
if (password) {
  app.use((req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization ?? "").split(" ");
    const [, given] = Buffer.from(encoded ?? "", "base64").toString().split(":");
    if (scheme === "Basic" && given === password) return next();
    res.set("WWW-Authenticate", 'Basic realm="Autowhats"').status(401).send("Acesso restrito");
  });
}

type Handler = (req: Request, res: Response) => Promise<unknown>;
const route = (fn: Handler) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res).catch(next);

app.get("/api/health", route(async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true });
}));

app.get("/api/diagnostico", route(async (_req, res) => {
  const key = process.env.ANTHROPIC_API_KEY ?? "";
  res.json({
    chave: key ? `${key.slice(0, 10)}... (${key.length} caracteres)` : "NÃO CONFIGURADA",
    modelo: process.env.AI_MODEL ?? "claude-opus-5-5",
    ia: await diagnoseAi(),
  });
}));

// --- Catálogo ---------------------------------------------------------------
app.get("/api/products", route(async (_req, res) => {
  res.json(await listProducts());
}));

app.post("/api/products", route(async (req, res) => {
  res.status(201).json(await createProduct(validateProduct(req.body)));
}));

app.put("/api/products/:id", route(async (req, res) => {
  const product = await updateProduct(Number(req.params.id), validateProduct(req.body));
  if (!product) return res.status(404).json({ error: "Produto não encontrado." });
  res.json(product);
}));

app.delete("/api/products/:id", route(async (req, res) => {
  if (!(await deleteProduct(Number(req.params.id))))
    return res.status(404).json({ error: "Produto não encontrado." });
  res.status(204).end();
}));

app.post("/api/import/csv", route(async (req, res) => {
  const products = productsFromCsv(String(req.body?.csv ?? ""));
  res.json({ ...(await upsertProducts(products)), total: products.length });
}));

app.post("/api/import/postgres", route(async (req, res) => {
  const products = await productsFromPostgres(
    String(req.body?.connectionString ?? ""),
    String(req.body?.query ?? ""),
  );
  res.json({ ...(await upsertProducts(products)), total: products.length });
}));

app.get("/api/import/modelo.csv", (_req, res) => {
  res.type("text/csv").attachment("modelo-catalogo.csv").send(
    "sku,nome,descricao,categoria,preco,tamanho,estoque\n" +
      'BON-STRAP,Boné Strapback,"Boné aba curva com regulagem",Acessórios,"59,90",Único,10\n' +
      'CAM-POLO,Camisa Polo,"Polo em piquet",Camisetas,"129,90",P,4\n' +
      'CAM-POLO,Camisa Polo,"Polo em piquet",Camisetas,"129,90",M,0\n' +
      'CAM-POLO,Camisa Polo,"Polo em piquet",Camisetas,"129,90",G,6\n',
  );
});

// --- Configurações da atendente --------------------------------------------
app.get("/api/settings", route(async (_req, res) => {
  res.json(await getSettings());
}));

app.put("/api/settings", route(async (req, res) => {
  res.json(await updateSettings(req.body ?? {}));
}));

// --- Conversas ---------------------------------------------------------------
app.post("/api/conversations", route(async (req, res) => {
  res.status(201).json(await startConversation(req.body?.customerName));
}));

app.post("/api/conversations/:id/messages", route(async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "Mensagem vazia." });
  if (text.length > 2000) return res.status(400).json({ error: "Mensagem muito longa." });
  const started = Date.now();
  console.log(`Chat: mensagem recebida (${text.length} caracteres)`);
  const replies = await chat(String(req.params.id), text);
  console.log(`Chat: ${replies.length} resposta(s) em ${Date.now() - started} ms`);
  res.json({ replies });
}));

// --- Métricas ----------------------------------------------------------------
app.get("/api/metrics", route(async (_req, res) => {
  const [counts, orders, outages, recent] = await Promise.all([
    pool.query(`
      SELECT
        count(*) FILTER (WHERE type = 'message_in')::int AS "messagesIn",
        COALESCE(sum((payload->>'count')::int) FILTER (WHERE type = 'message_out'), 0)::int AS "messagesOut",
        count(*) FILTER (WHERE type = 'stock_out')::int AS "stockOutChecks"
      FROM events`),
    pool.query(`
      SELECT count(*)::int AS "orders", COALESCE(sum(total), 0)::float AS "revenue",
             (SELECT count(*)::int FROM conversations) AS "conversations"
      FROM orders`),
    pool.query(`
      SELECT payload->>'produto' AS produto, NULLIF(payload->>'tamanho', '') AS tamanho, count(*)::int AS vezes
      FROM events WHERE type = 'stock_out'
      GROUP BY 1, 2 ORDER BY vezes DESC, produto LIMIT 5`),
    pool.query(`
      SELECT id, items, total::float AS total, fulfillment, created_at
      FROM orders ORDER BY id DESC LIMIT 5`),
  ]);
  res.json({ ...counts.rows[0], ...orders.rows[0], topStockOuts: outages.rows, recentOrders: recent.rows });
}));

// --- Erros -------------------------------------------------------------------
app.use("/api", (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
  if (err instanceof Anthropic.APIError) console.error(`Erro da API Anthropic (${err.status ?? "rede"}):`, err.message);
  if (err instanceof Anthropic.AuthenticationError)
    return res.status(502).json({ error: "Chave da API da Anthropic inválida. Confira o ANTHROPIC_API_KEY no .env." });
  if (err instanceof Anthropic.RateLimitError)
    return res.status(503).json({ error: "Muitas mensagens ao mesmo tempo. Tente de novo em alguns segundos." });
  if (err instanceof Anthropic.APIError)
    return res.status(502).json({ error: `Falha na IA (${err.status ?? "rede"}): ${err.message}` });
  console.error(err);
  res.status(500).json({ error: "Erro interno do servidor." });
});

// --- Frontend em produção ----------------------------------------------------
if (process.env.NODE_ENV === "production") {
  const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");
  app.use(express.static(dist));
  app.get("/{*splat}", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

await migrate();
if (await seedIfEmpty()) console.log("Catálogo de exemplo carregado.");

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => console.log(`Autowhats rodando em http://localhost:${port}`));
