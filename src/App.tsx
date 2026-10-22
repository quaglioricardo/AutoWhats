import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { Product, StoreSettings } from "./types";
import WhatsAppSimulator from "./components/WhatsAppSimulator";
import CatalogManager from "./components/CatalogManager";
import DashboardMetrics from "./components/DashboardMetrics";

type Tab = "catalogo" | "painel";

export default function App() {
  const [tab, setTab] = useState<Tab>("catalogo");
  const [products, setProducts] = useState<Product[]>([]);
  const [settings, setSettings] = useState<StoreSettings | null>(null);
  // Bumped after each chat reply so the metrics panel refreshes.
  const [activity, setActivity] = useState(0);
  const [loadError, setLoadError] = useState("");

  const refreshProducts = useCallback(() => api.products().then(setProducts), []);

  useEffect(() => {
    Promise.all([refreshProducts(), api.settings().then(setSettings)]).catch((e) =>
      setLoadError(e.message),
    );
  }, [refreshProducts]);

  const onChatActivity = useCallback(() => {
    setActivity((n) => n + 1);
    // An order lowers stock, so keep the catalog grid in sync with the database.
    refreshProducts().catch(() => {});
  }, [refreshProducts]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot">A</span>
          <strong>Autowhats</strong>
          <span className="brand-sub">Atendimento com IA para varejo</span>
        </div>
        {settings && (
          <span className="topbar-store">
            {settings.storeName} · atendente {settings.assistantName}
          </span>
        )}
      </header>

      {loadError && <div className="banner-error">Não foi possível falar com o servidor: {loadError}</div>}

      <main className="workspace">
        <section className="pane-chat">
          {settings && <WhatsAppSimulator settings={settings} onActivity={onChatActivity} />}
        </section>

        <section className="pane-admin">
          <nav className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "catalogo"} onClick={() => setTab("catalogo")}>
              Estoque &amp; Catálogo
            </button>
            <button role="tab" aria-selected={tab === "painel"} onClick={() => setTab("painel")}>
              Painel da {settings?.assistantName ?? "Isis"} &amp; Métricas
            </button>
          </nav>
          <div className="tab-body">
            {tab === "catalogo" ? (
              <CatalogManager products={products} onChange={refreshProducts} />
            ) : (
              settings && (
                <DashboardMetrics settings={settings} onSettingsSaved={setSettings} activity={activity} />
              )
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
