import type { PoolClient } from "pg";
import { pool } from "./db.js";

export interface SizeStock {
  size: string;
  stock: number;
}

export interface Product {
  id: number;
  sku: string;
  name: string;
  description: string;
  category: string;
  price: number;
  active: boolean;
  sizes: SizeStock[];
  updated_at: string;
}

export type ProductInput = Omit<Product, "id" | "updated_at">;

export type Tone = "amigavel" | "profissional" | "descontraido";

export interface StoreSettings {
  assistantName: string;
  tone: Tone;
  storeName: string;
  address: string;
  openingHours: string;
  greeting: string;
  deliveryFee: number;
  deliveryInfo: string;
  /** WhatsApp numbers the assistant never answers, one per line. */
  ignoredNumbers: string;
  /** How long the assistant stays quiet in a chat after the shopkeeper replies by hand. */
  humanPauseMinutes: number;
}

export const DEFAULT_SETTINGS: StoreSettings = {
  assistantName: "Isis",
  tone: "amigavel",
  storeName: "Loja Modelo",
  address: "Avenida Paulista, 1000 - Bela Vista, São Paulo/SP",
  openingHours: "Segunda a sábado, das 10h às 22h. Domingo, das 14h às 20h.",
  greeting:
    "Olá! Eu sou a {nome}, atendente virtual da {loja} 😊 Posso consultar preços, tamanhos e estoque para você. O que está procurando hoje?",
  deliveryFee: 15,
  deliveryInfo: "Entrega em até 2 dias úteis para a cidade de São Paulo.",
  ignoredNumbers: "",
  humanPauseMinutes: 60,
};

export class ValidationError extends Error {}

export function validateProduct(raw: unknown): ProductInput {
  const p = raw as Partial<ProductInput>;
  const sku = String(p.sku ?? "").trim();
  const name = String(p.name ?? "").trim();
  const price = Number(p.price);
  if (!sku) throw new ValidationError("SKU é obrigatório.");
  if (!name) throw new ValidationError("Nome é obrigatório.");
  if (!Number.isFinite(price) || price < 0) throw new ValidationError("Preço inválido.");

  const sizes: SizeStock[] = [];
  const seen = new Set<string>();
  for (const s of Array.isArray(p.sizes) ? p.sizes : []) {
    const size = String(s?.size ?? "").trim();
    const stock = Math.trunc(Number(s?.stock));
    if (!size) continue;
    if (!Number.isFinite(stock) || stock < 0)
      throw new ValidationError(`Estoque inválido no tamanho ${size}.`);
    const key = size.toUpperCase();
    if (seen.has(key)) throw new ValidationError(`Tamanho ${size} repetido.`);
    seen.add(key);
    sizes.push({ size, stock });
  }
  if (sizes.length === 0) throw new ValidationError("Informe ao menos um tamanho.");

  return {
    sku,
    name,
    price: Math.round(price * 100) / 100,
    description: String(p.description ?? "").trim(),
    category: String(p.category ?? "").trim(),
    active: p.active !== false,
    sizes,
  };
}

const PRODUCT_SELECT = `
  SELECT p.id, p.sku, p.name, p.description, p.category, p.price, p.active, p.updated_at,
         COALESCE(
           json_agg(json_build_object('size', s.size, 'stock', s.stock) ORDER BY s.position, s.id)
             FILTER (WHERE s.id IS NOT NULL),
           '[]'
         ) AS sizes
  FROM products p
  LEFT JOIN product_sizes s ON s.product_id = p.id
`;

export async function listProducts(opts: { onlyActive?: boolean } = {}): Promise<Product[]> {
  const where = opts.onlyActive ? "WHERE p.active" : "";
  const { rows } = await pool.query(
    `${PRODUCT_SELECT} ${where} GROUP BY p.id ORDER BY p.category, p.name`,
  );
  return rows;
}

export async function getProduct(id: number): Promise<Product | null> {
  const { rows } = await pool.query(`${PRODUCT_SELECT} WHERE p.id = $1 GROUP BY p.id`, [id]);
  return rows[0] ?? null;
}

async function writeSizes(client: PoolClient, productId: number, sizes: SizeStock[]) {
  await client.query("DELETE FROM product_sizes WHERE product_id = $1", [productId]);
  for (const [i, s] of sizes.entries()) {
    await client.query(
      "INSERT INTO product_sizes (product_id, size, stock, position) VALUES ($1, $2, $3, $4)",
      [productId, s.size, s.stock, i],
    );
  }
}

async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Inserts or updates by SKU. Returns the product id and whether it was new. */
async function upsertOne(client: PoolClient, p: ProductInput) {
  const { rows } = await client.query(
    `INSERT INTO products (sku, name, description, category, price, active)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (sku) DO UPDATE SET
       name = EXCLUDED.name, description = EXCLUDED.description,
       category = EXCLUDED.category, price = EXCLUDED.price,
       active = EXCLUDED.active, updated_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [p.sku, p.name, p.description, p.category, p.price, p.active],
  );
  await writeSizes(client, rows[0].id, p.sizes);
  return { id: rows[0].id as number, inserted: rows[0].inserted as boolean };
}

export async function createProduct(p: ProductInput): Promise<Product> {
  const exists = await pool.query("SELECT 1 FROM products WHERE sku = $1", [p.sku]);
  if (exists.rowCount) throw new ValidationError(`Já existe um produto com o SKU ${p.sku}.`);
  const { id } = await inTransaction((c) => upsertOne(c, p));
  return (await getProduct(id))!;
}

export async function updateProduct(id: number, p: ProductInput): Promise<Product | null> {
  const clash = await pool.query("SELECT 1 FROM products WHERE sku = $1 AND id <> $2", [p.sku, id]);
  if (clash.rowCount) throw new ValidationError(`Já existe outro produto com o SKU ${p.sku}.`);
  const updated = await inTransaction(async (c) => {
    const { rowCount } = await c.query(
      `UPDATE products SET sku = $2, name = $3, description = $4, category = $5,
         price = $6, active = $7, updated_at = now() WHERE id = $1`,
      [id, p.sku, p.name, p.description, p.category, p.price, p.active],
    );
    if (!rowCount) return false;
    await writeSizes(c, id, p.sizes);
    return true;
  });
  return updated ? getProduct(id) : null;
}

export async function deleteProduct(id: number): Promise<boolean> {
  const { rowCount } = await pool.query("DELETE FROM products WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}

export async function upsertProducts(products: ProductInput[]) {
  return inTransaction(async (c) => {
    let created = 0;
    let updated = 0;
    for (const p of products) {
      const r = await upsertOne(c, p);
      if (r.inserted) created++;
      else updated++;
    }
    return { created, updated };
  });
}

export async function getSettings(): Promise<StoreSettings> {
  const { rows } = await pool.query("SELECT data FROM settings WHERE id = 1");
  return { ...DEFAULT_SETTINGS, ...(rows[0]?.data ?? {}) };
}

export async function updateSettings(patch: Partial<StoreSettings>): Promise<StoreSettings> {
  const current = await getSettings();
  const next: StoreSettings = { ...current };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof StoreSettings)[]) {
    if (patch[key] !== undefined) (next as any)[key] = patch[key];
  }
  if (!["amigavel", "profissional", "descontraido"].includes(next.tone))
    throw new ValidationError("Tom de voz inválido.");
  next.deliveryFee = Number(next.deliveryFee) || 0;
  next.humanPauseMinutes = Math.max(0, Math.trunc(Number(next.humanPauseMinutes) || 0));
  next.ignoredNumbers = String(next.ignoredNumbers ?? "");
  next.assistantName = String(next.assistantName).trim() || DEFAULT_SETTINGS.assistantName;
  await pool.query(
    `INSERT INTO settings (id, data) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
    [next],
  );
  return next;
}
