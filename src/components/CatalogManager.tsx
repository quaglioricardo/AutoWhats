import { useMemo, useState, type FormEvent } from "react";
import { api, brl } from "../api";
import type { Product, ProductInput, SizeStock } from "../types";

const PRESETS: { label: string; sizes: string[] }[] = [
  { label: "P M G GG", sizes: ["P", "M", "G", "GG"] },
  { label: "Calças 36–46", sizes: ["36", "38", "40", "42", "44", "46"] },
  { label: "Calçados 34–44", sizes: ["34", "35", "36", "37", "38", "39", "40", "41", "42", "43", "44"] },
  { label: "Único", sizes: ["Único"] },
];

const EMPTY: ProductInput = {
  sku: "",
  name: "",
  description: "",
  category: "",
  price: 0,
  active: true,
  sizes: [{ size: "Único", stock: 0 }],
};

const POSTGRES_EXAMPLE = `SELECT p.codigo AS sku, p.nome, p.descricao, p.categoria,
       p.preco_venda AS preco, e.tamanho, e.quantidade AS estoque
FROM produtos p
JOIN estoque e ON e.produto_id = p.id
WHERE p.ativo`;

interface Props {
  products: Product[];
  onChange: () => Promise<unknown>;
}

export default function CatalogManager({ products, onChange }: Props) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ id: number | null; data: ProductInput } | null>(null);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) =>
      [p.name, p.sku, p.category].some((f) => f.toLowerCase().includes(q)),
    );
  }, [products, query]);

  const totals = useMemo(() => {
    const units = products.reduce((n, p) => n + p.sizes.reduce((m, s) => m + s.stock, 0), 0);
    const outOfStock = products.reduce((n, p) => n + p.sizes.filter((s) => s.stock === 0).length, 0);
    return { units, outOfStock };
  }, [products]);

  function flash(msg: string) {
    setNotice(msg);
    setTimeout(() => setNotice((n) => (n === msg ? "" : n)), 4000);
  }

  async function remove(p: Product) {
    if (!confirm(`Remover "${p.name}" do catálogo?`)) return;
    try {
      await api.deleteProduct(p.id);
      await onChange();
      flash(`"${p.name}" removido. A Isis já não oferece mais esse produto.`);
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function toggleActive(p: Product) {
    const { id, updated_at, ...data } = p;
    await api.updateProduct(id, { ...data, active: !p.active });
    await onChange();
  }

  return (
    <div className="catalog">
      <div className="catalog-summary">
        <div>
          <strong>{products.length}</strong> produtos
        </div>
        <div>
          <strong>{totals.units}</strong> unidades em estoque
        </div>
        <div className={totals.outOfStock ? "is-warn" : ""}>
          <strong>{totals.outOfStock}</strong> tamanhos esgotados
        </div>
      </div>

      <div className="catalog-toolbar">
        <input
          className="field"
          placeholder="Buscar por nome, SKU ou categoria"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn" onClick={() => setImporting(true)}>
          Importar
        </button>
        <button className="btn btn-primary" onClick={() => setEditing({ id: null, data: structuredClone(EMPTY) })}>
          + Novo produto
        </button>
      </div>

      <p className="hint">
        Sincronização em tempo real: a {""}
        <strong>IA consulta este catálogo a cada mensagem</strong>, então qualquer alteração vale na próxima
        pergunta do cliente.
      </p>
      {notice && <div className="notice">{notice}</div>}

      <ul className="product-list">
        {filtered.map((p) => (
          <li key={p.id} className={`product ${p.active ? "" : "is-inactive"}`}>
            <div className="product-head">
              <div>
                <div className="product-name">
                  {p.name} {!p.active && <span className="tag">inativo</span>}
                </div>
                <div className="product-meta">
                  {p.sku}
                  {p.category && ` · ${p.category}`}
                </div>
              </div>
              <div className="product-price">{brl(p.price)}</div>
            </div>
            {p.description && <p className="product-desc">{p.description}</p>}
            <div className="size-chips">
              {p.sizes.map((s) => (
                <span key={s.size} className={`chip ${s.stock === 0 ? "is-out" : s.stock <= 2 ? "is-low" : ""}`}>
                  {s.size} <b>{s.stock === 0 ? "esgotado" : s.stock}</b>
                </span>
              ))}
            </div>
            <div className="product-actions">
              <label className="switch">
                <input type="checkbox" checked={p.active} onChange={() => toggleActive(p)} />
                <span>{p.active ? "À venda" : "Fora de venda"}</span>
              </label>
              <button
                className="btn btn-small"
                onClick={() => {
                  const { id, updated_at, ...data } = p;
                  setEditing({ id, data: structuredClone(data) });
                }}
              >
                Editar
              </button>
              <button className="btn btn-small btn-danger" onClick={() => remove(p)}>
                Remover
              </button>
            </div>
          </li>
        ))}
        {filtered.length === 0 && <li className="empty">Nenhum produto encontrado.</li>}
      </ul>

      {editing && (
        <ProductEditor
          initial={editing.data}
          isNew={editing.id === null}
          onCancel={() => setEditing(null)}
          onSave={async (data) => {
            if (editing.id === null) await api.createProduct(data);
            else await api.updateProduct(editing.id, data);
            await onChange();
            setEditing(null);
            flash(`"${data.name}" salvo. A Isis já conhece a alteração.`);
          }}
        />
      )}

      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onDone={async (msg) => {
            await onChange();
            setImporting(false);
            flash(msg);
          }}
        />
      )}
    </div>
  );
}

function ProductEditor(props: {
  initial: ProductInput;
  isNew: boolean;
  onCancel: () => void;
  onSave: (p: ProductInput) => Promise<void>;
}) {
  const [data, setData] = useState(props.initial);
  const [priceText, setPriceText] = useState(props.isNew ? "" : props.initial.price.toFixed(2).replace(".", ","));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof ProductInput>(k: K, v: ProductInput[K]) => setData((d) => ({ ...d, [k]: v }));
  const setSize = (i: number, patch: Partial<SizeStock>) =>
    set("sizes", data.sizes.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  function applyPreset(sizes: string[]) {
    const current = new Map(data.sizes.map((s) => [s.size, s.stock]));
    set("sizes", sizes.map((size) => ({ size, stock: current.get(size) ?? 0 })));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const price = Number(priceText.replace(/\./g, "").replace(",", "."));
    if (!Number.isFinite(price) || priceText.trim() === "") return setError("Informe um preço válido, ex.: 59,90");
    setSaving(true);
    try {
      await props.onSave({ ...data, price, sizes: data.sizes.filter((s) => s.size.trim()) });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={props.onCancel}>
      <form className="modal" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <h2>{props.isNew ? "Novo produto" : "Editar produto"}</h2>
        <div className="form-grid">
          <label>
            Nome
            <input className="field" value={data.name} onChange={(e) => set("name", e.target.value)} required autoFocus />
          </label>
          <label>
            SKU
            <input className="field" value={data.sku} onChange={(e) => set("sku", e.target.value.toUpperCase())} required />
          </label>
          <label>
            Preço (R$)
            <input
              className="field"
              inputMode="decimal"
              placeholder="59,90"
              value={priceText}
              onChange={(e) => setPriceText(e.target.value)}
              required
            />
          </label>
          <label>
            Categoria
            <input className="field" value={data.category} onChange={(e) => set("category", e.target.value)} />
          </label>
          <label className="span-2">
            Descrição
            <textarea
              className="field"
              rows={2}
              value={data.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="Material, cores, modelagem... A IA usa este texto para responder."
            />
          </label>
        </div>

        <div className="sizes-editor">
          <div className="sizes-editor-head">
            <strong>Grade de tamanhos e estoque</strong>
            <div className="presets">
              {PRESETS.map((p) => (
                <button type="button" key={p.label} className="btn btn-small" onClick={() => applyPreset(p.sizes)}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="sizes-grid">
            {data.sizes.map((s, i) => (
              <div key={i} className="size-row">
                <input
                  className="field"
                  value={s.size}
                  placeholder="Tamanho"
                  onChange={(e) => setSize(i, { size: e.target.value })}
                  aria-label="Tamanho"
                />
                <input
                  className="field"
                  type="number"
                  min={0}
                  value={s.stock}
                  onChange={(e) => setSize(i, { stock: Math.max(0, parseInt(e.target.value || "0", 10)) })}
                  aria-label={`Estoque do tamanho ${s.size}`}
                />
                <button
                  type="button"
                  className="btn btn-small"
                  title="Zerar estoque"
                  onClick={() => setSize(i, { stock: 0 })}
                >
                  Zerar
                </button>
                <button
                  type="button"
                  className="btn btn-small btn-danger"
                  title="Remover tamanho"
                  onClick={() => set("sizes", data.sizes.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <button type="button" className="btn btn-small" onClick={() => set("sizes", [...data.sizes, { size: "", stock: 0 }])}>
            + Tamanho
          </button>
        </div>

        <label className="switch">
          <input type="checkbox" checked={data.active} onChange={(e) => set("active", e.target.checked)} />
          <span>Produto à venda (visível para a IA)</span>
        </label>

        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={props.onCancel}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={saving}>
            {saving ? "Salvando..." : "Salvar"}
          </button>
        </div>
      </form>
    </div>
  );
}

function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => Promise<void> }) {
  const [mode, setMode] = useState<"csv" | "postgres">("csv");
  const [csv, setCsv] = useState("");
  const [conn, setConn] = useState("");
  const [sql, setSql] = useState(POSTGRES_EXAMPLE);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);

  async function run() {
    setError("");
    setRunning(true);
    try {
      const r = mode === "csv" ? await api.importCsv(csv) : await api.importPostgres(conn, sql);
      await onDone(`Importação concluída: ${r.created} produtos novos e ${r.updated} atualizados.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Importar catálogo</h2>
        <div className="segmented">
          <button aria-pressed={mode === "csv"} onClick={() => setMode("csv")}>
            Planilha CSV
          </button>
          <button aria-pressed={mode === "postgres"} onClick={() => setMode("postgres")}>
            Banco do cliente (Postgres)
          </button>
        </div>

        {mode === "csv" ? (
          <>
            <p className="hint">
              Uma linha por tamanho, com as colunas <code>sku, nome, descricao, categoria, preco, tamanho, estoque</code>.
              Produtos com SKU já cadastrado são atualizados. <a href="/api/import/modelo.csv">Baixar modelo</a>
            </p>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) setCsv(await file.text());
              }}
            />
            <textarea
              className="field mono"
              rows={8}
              placeholder="...ou cole o conteúdo do CSV aqui"
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
            />
          </>
        ) : (
          <>
            <p className="hint">
              Lemos os produtos direto do banco da loja, em modo somente leitura. A consulta deve devolver as mesmas
              colunas do CSV; use <code>AS</code> para renomear as colunas do cliente.
            </p>
            <input
              className="field mono"
              placeholder="postgres://usuario:senha@host:5432/banco"
              value={conn}
              onChange={(e) => setConn(e.target.value)}
            />
            <textarea className="field mono" rows={8} value={sql} onChange={(e) => setSql(e.target.value)} />
          </>
        )}

        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="btn btn-primary"
            onClick={run}
            disabled={running || (mode === "csv" ? !csv.trim() : !conn.trim() || !sql.trim())}
          >
            {running ? "Importando..." : "Importar"}
          </button>
        </div>
      </div>
    </div>
  );
}
