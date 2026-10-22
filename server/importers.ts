import { parse } from "csv-parse/sync";
import pg from "pg";
import { ValidationError, validateProduct, type ProductInput } from "./catalog.js";

/**
 * Both importers produce "long format" rows: one row per product size.
 * Rows sharing a SKU are merged into a single product with its size grid.
 * A "tamanhos" column like "P:5;M:3;G:0" is also accepted instead of one row per size.
 */
type RawRow = Record<string, unknown>;

const ALIASES: Record<string, string[]> = {
  sku: ["sku", "codigo", "código", "cod", "ref", "referencia", "referência"],
  name: ["nome", "name", "produto", "descricao_curta"],
  description: ["descricao", "descrição", "description", "detalhes"],
  category: ["categoria", "category", "departamento"],
  price: ["preco", "preço", "price", "valor"],
  size: ["tamanho", "size", "tam", "numeracao", "numeração"],
  stock: ["estoque", "stock", "quantidade", "qtd", "saldo"],
  sizes: ["tamanhos", "grade", "sizes"],
  active: ["ativo", "active"],
};

function normalizeKey(k: string) {
  return k.trim().toLowerCase();
}

function pick(row: RawRow, field: keyof typeof ALIASES): unknown {
  for (const [k, v] of Object.entries(row)) {
    if (ALIASES[field].includes(normalizeKey(k))) return v;
  }
  return undefined;
}

/** Accepts 89.90, "89,90", "R$ 1.299,90". */
export function parsePrice(v: unknown): number {
  if (typeof v === "number") return v;
  let s = String(v ?? "").replace(/[R$\s]/g, "");
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  return Number(s);
}

function parseActive(v: unknown) {
  if (v === undefined || v === null || v === "") return true;
  return !["0", "false", "nao", "não", "n", "inativo"].includes(String(v).trim().toLowerCase());
}

export function rowsToProducts(rows: RawRow[]): ProductInput[] {
  const bySku = new Map<string, RawRow & { _sizes: { size: string; stock: number }[] }>();
  const errors: string[] = [];

  rows.forEach((row, i) => {
    const line = i + 2; // header is line 1
    const sku = String(pick(row, "sku") ?? "").trim();
    if (!sku) {
      errors.push(`Linha ${line}: SKU vazio.`);
      return;
    }
    let entry = bySku.get(sku);
    if (!entry) {
      entry = { ...row, _sizes: [] };
      bySku.set(sku, entry);
    }
    const grid = pick(row, "sizes");
    if (grid) {
      for (const part of String(grid).split(/[;|]/)) {
        const [size, stock] = part.split(":");
        if (size?.trim()) entry._sizes.push({ size: size.trim(), stock: Number(stock ?? 0) });
      }
    }
    const size = pick(row, "size");
    if (size !== undefined && String(size).trim()) {
      entry._sizes.push({ size: String(size).trim(), stock: Number(pick(row, "stock") ?? 0) });
    }
    if (!grid && (size === undefined || !String(size).trim())) {
      entry._sizes.push({ size: "Único", stock: Number(pick(row, "stock") ?? 0) });
    }
  });

  const products: ProductInput[] = [];
  for (const [sku, row] of bySku) {
    try {
      products.push(
        validateProduct({
          sku,
          name: pick(row, "name"),
          description: pick(row, "description"),
          category: pick(row, "category"),
          price: parsePrice(pick(row, "price")),
          active: parseActive(pick(row, "active")),
          sizes: row._sizes,
        }),
      );
    } catch (err) {
      errors.push(`SKU ${sku}: ${(err as Error).message}`);
    }
  }
  if (errors.length) throw new ValidationError(errors.slice(0, 10).join("\n"));
  return products;
}

export function productsFromCsv(text: string): ProductInput[] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  let rows: RawRow[];
  try {
    rows = parse(text, { columns: true, skip_empty_lines: true, trim: true, bom: true, delimiter });
  } catch (err) {
    throw new ValidationError(`CSV inválido: ${(err as Error).message}`);
  }
  if (rows.length === 0) throw new ValidationError("O CSV não tem linhas de produtos.");
  return rowsToProducts(rows);
}

/**
 * Reads products from the store's own Postgres database. The query must return
 * the same columns as the CSV (sku, nome, preco, tamanho, estoque, ...), so the
 * lojista maps their schema with column aliases, e.g. `SELECT cod AS sku, ...`.
 * Runs in a read-only transaction with a timeout.
 */
export async function productsFromPostgres(connectionString: string, query: string) {
  if (!/^postgres(ql)?:\/\//.test(connectionString))
    throw new ValidationError("A conexão deve começar com postgres://");
  if (!/^\s*(select|with)\b/i.test(query))
    throw new ValidationError("A consulta deve ser um SELECT.");

  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 8000 });
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = 15000");
    const { rows } = await client.query(query);
    await client.query("ROLLBACK");
    if (rows.length === 0) throw new ValidationError("A consulta não retornou produtos.");
    return rowsToProducts(rows);
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError(`Erro no banco do cliente: ${(err as Error).message}`);
  } finally {
    await client.end().catch(() => {});
  }
}
