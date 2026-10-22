import type { ConversationStart, Metrics, Product, ProductInput, StoreSettings } from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Erro ${res.status}`);
  return body as T;
}

const json = (method: string, data: unknown): RequestInit => ({ method, body: JSON.stringify(data) });

export const api = {
  products: () => request<Product[]>("/api/products"),
  createProduct: (p: ProductInput) => request<Product>("/api/products", json("POST", p)),
  updateProduct: (id: number, p: ProductInput) => request<Product>(`/api/products/${id}`, json("PUT", p)),
  deleteProduct: (id: number) => request<void>(`/api/products/${id}`, { method: "DELETE" }),
  importCsv: (csv: string) =>
    request<{ created: number; updated: number; total: number }>("/api/import/csv", json("POST", { csv })),
  importPostgres: (connectionString: string, query: string) =>
    request<{ created: number; updated: number; total: number }>(
      "/api/import/postgres",
      json("POST", { connectionString, query }),
    ),
  settings: () => request<StoreSettings>("/api/settings"),
  saveSettings: (s: Partial<StoreSettings>) => request<StoreSettings>("/api/settings", json("PUT", s)),
  startConversation: () => request<ConversationStart>("/api/conversations", json("POST", {})),
  sendMessage: (id: string, text: string) =>
    request<{ replies: string[] }>(`/api/conversations/${id}/messages`, json("POST", { text })),
  metrics: () => request<Metrics>("/api/metrics"),
};

export const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
