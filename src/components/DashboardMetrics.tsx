import { useEffect, useState, type FormEvent } from "react";
import { api, brl } from "../api";
import type { Metrics, StoreSettings, Tone } from "../types";

const TONES: { value: Tone; label: string; sample: string }[] = [
  { value: "amigavel", label: "Amigável", sample: "Oi! Temos sim 😊" },
  { value: "profissional", label: "Profissional", sample: "Olá. Temos disponível." },
  { value: "descontraido", label: "Descontraído", sample: "Opa, tem sim! 🔥" },
];

interface Props {
  settings: StoreSettings;
  onSettingsSaved: (s: StoreSettings) => void;
  activity: number;
}

export default function DashboardMetrics({ settings, onSettingsSaved, activity }: Props) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [form, setForm] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    api.metrics().then(setMetrics).catch(() => {});
  }, [activity]);

  const set = <K extends keyof StoreSettings>(k: K, v: StoreSettings[K]) => setForm((f) => ({ ...f, [k]: v }));
  const dirty = JSON.stringify(form) !== JSON.stringify(settings);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setStatus("");
    try {
      const saved = await api.saveSettings(form);
      onSettingsSaved(saved);
      setForm(saved);
      setStatus("Configurações salvas. Tom e dados da loja valem na próxima mensagem; a saudação, na próxima conversa.");
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const conversion = metrics && metrics.conversations ? (metrics.orders / metrics.conversations) * 100 : 0;

  return (
    <div className="dashboard">
      <section>
        <h3>Métricas de atendimento</h3>
        <div className="stats">
          <Stat label="Mensagens processadas" value={metrics?.messagesIn} sub={`${metrics?.messagesOut ?? 0} respostas enviadas`} />
          <Stat label="Checagens de falta de estoque" value={metrics?.stockOutChecks} sub="produto ou tamanho esgotado" />
          <Stat label="Pedidos simulados" value={metrics?.orders} sub={`${conversion.toFixed(0)}% das ${metrics?.conversations ?? 0} conversas (${metrics?.whatsappConversations ?? 0} no WhatsApp)`} />
          <Stat label="Faturamento estimado" value={metrics ? brl(metrics.revenue) : undefined} sub="soma dos pedidos simulados" />
        </div>

        <div className="dash-lists">
          <div>
            <h4>Mais procurados sem estoque</h4>
            {metrics?.topStockOuts.length ? (
              <ol className="ranked">
                {metrics.topStockOuts.map((s, i) => (
                  <li key={i}>
                    <span>
                      {s.produto}
                      {s.tamanho && <small> · tam. {s.tamanho}</small>}
                    </span>
                    <b>{s.vezes}×</b>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="empty">Nenhuma falta de estoque registrada ainda.</p>
            )}
          </div>
          <div>
            <h4>Últimos pedidos</h4>
            {metrics?.recentOrders.length ? (
              <ul className="orders">
                {metrics.recentOrders.map((o) => (
                  <li key={o.id}>
                    <div>
                      <b>#{o.id}</b> · {o.items.map((it) => `${it.quantidade}× ${it.nome} (${it.tamanho})`).join(", ")}
                    </div>
                    <small>
                      {brl(o.total)} · {o.fulfillment === "entrega" ? "entrega em casa" : "retirada na loja"} ·{" "}
                      {new Date(o.created_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}
                    </small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty">Nenhum pedido fechado ainda.</p>
            )}
          </div>
        </div>
      </section>

      <form className="settings" onSubmit={save}>
        <h3>Configurações da {settings.assistantName}</h3>
        <div className="form-grid">
          <label>
            Nome da atendente virtual
            <input className="field" value={form.assistantName} onChange={(e) => set("assistantName", e.target.value)} />
          </label>
          <label>
            Nome da loja
            <input className="field" value={form.storeName} onChange={(e) => set("storeName", e.target.value)} />
          </label>
          <div className="span-2">
            <span className="label">Tom de voz</span>
            <div className="tone-picker">
              {TONES.map((t) => (
                <button
                  type="button"
                  key={t.value}
                  aria-pressed={form.tone === t.value}
                  onClick={() => set("tone", t.value)}
                >
                  <strong>{t.label}</strong>
                  <small>“{t.sample}”</small>
                </button>
              ))}
            </div>
          </div>
          <label className="span-2">
            Endereço da loja (retirada)
            <input className="field" value={form.address} onChange={(e) => set("address", e.target.value)} />
          </label>
          <label className="span-2">
            Horário de funcionamento
            <input className="field" value={form.openingHours} onChange={(e) => set("openingHours", e.target.value)} />
          </label>
          <label>
            Taxa de entrega (R$)
            <input
              className="field"
              type="number"
              min={0}
              step="0.01"
              value={form.deliveryFee}
              onChange={(e) => set("deliveryFee", Number(e.target.value))}
            />
          </label>
          <label>
            Prazo e regras de entrega
            <input className="field" value={form.deliveryInfo} onChange={(e) => set("deliveryInfo", e.target.value)} />
          </label>
          <label className="span-2">
            Saudação inicial no WhatsApp (use {"{nome}"} e {"{loja}"} para inserir os nomes)
            <textarea className="field" rows={3} value={form.greeting} onChange={(e) => set("greeting", e.target.value)} />
          </label>
        </div>
        {status && <div className="notice">{status}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" disabled={!dirty} onClick={() => setForm(settings)}>
            Descartar
          </button>
          <button className="btn btn-primary" disabled={!dirty || saving}>
            {saving ? "Salvando..." : "Salvar configurações"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: number | string | undefined; sub: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value ?? "–"}</div>
      <div className="stat-sub">{sub}</div>
    </div>
  );
}
