import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../api";
import type { StoreSettings } from "../types";

type Status = "sent" | "delivered" | "read" | "error";

interface ChatMessage {
  id: number;
  from: "me" | "them";
  text: string;
  time: string;
  status?: Status;
}

const SUGGESTIONS = [
  "Olá, vocês têm a Camiseta Classic no tamanho M? Quanto custa?",
  "E no tamanho G, tem?",
  "Gostaria de fechar o pedido do tênis Air Sport",
  "Vocês vendem boné?",
];

const now = () => new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let nextId = 1;

/** Renders WhatsApp inline formatting: *negrito*, _itálico_, ~riscado~ and links. */
function formatWhatsApp(text: string): ReactNode[] {
  const pattern = /(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|https?:\/\/\S+)/g;
  return text.split(pattern).map((part, i) => {
    if (/^\*[^*]+\*$/.test(part)) return <strong key={i}>{part.slice(1, -1)}</strong>;
    if (/^_[^_]+_$/.test(part)) return <em key={i}>{part.slice(1, -1)}</em>;
    if (/^~[^~]+~$/.test(part)) return <s key={i}>{part.slice(1, -1)}</s>;
    if (/^https?:\/\//.test(part))
      return (
        <a key={i} href={part} target="_blank" rel="noreferrer">
          {part}
        </a>
      );
    return part;
  });
}

function Checks({ status }: { status?: Status }) {
  if (status === "error") return <span className="wa-check wa-check-error" title="Não enviada">!</span>;
  const double = status === "delivered" || status === "read";
  return (
    <svg className={`wa-check ${status === "read" ? "is-read" : ""}`} viewBox="0 0 16 11" width="16" height="11" aria-label={status}>
      <path d="M11.07.65 4.6 7.12 1.93 4.45.87 5.5l3.73 3.74 7.53-7.53z" fill="currentColor" />
      {double && <path d="m15.13.65-6.47 6.47-.6-.6-1.06 1.06 1.66 1.66 7.53-7.53z" fill="currentColor" />}
    </svg>
  );
}

const Icon = {
  search: <path d="M15.9 14.3h-.8l-.3-.3a6.5 6.5 0 1 0-.7.7l.3.3v.8l5 5 1.5-1.5-5-5Zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Z" />,
  emoji: <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16Zm-3.5-9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm7 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM12 17.5c2.3 0 4.3-1.4 5.1-3.5H6.9c.8 2.1 2.8 3.5 5.1 3.5Z" />,
  clip: <path d="M16.5 6v11.5a4 4 0 0 1-8 0V5a2.5 2.5 0 0 1 5 0v10.5a1 1 0 0 1-2 0V6H10v9.5a2.5 2.5 0 0 0 5 0V5a4 4 0 0 0-8 0v12.5a5.5 5.5 0 0 0 11 0V6h-1.5Z" />,
  send: <path d="M1.1 21.8 23 12 1.1 2.2 1.1 9.8 16.7 12 1.1 14.2z" />,
  mic: <path d="M12 15a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v7a3 3 0 0 0 3 3Zm5.3-3c0 3-2.5 5.1-5.3 5.1S6.7 15 6.7 12H5c0 3.4 2.7 6.2 6 6.7V22h2v-3.3c3.3-.5 6-3.3 6-6.7h-1.7Z" />,
  refresh: <path d="M17.7 6.3A8 8 0 1 0 19.7 14h-2.1A6 6 0 1 1 12 6c1.7 0 3.1.7 4.2 1.8L13 11h7V4l-2.3 2.3Z" />,
  menu: <path d="M12 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm0 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z" />,
};

const Svg = ({ children, label }: { children: ReactNode; label?: string }) => (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden={!label} aria-label={label}>
    {children}
  </svg>
);

interface Props {
  settings: StoreSettings;
  onActivity: () => void;
}

export default function WhatsAppSimulator({ settings, onActivity }: Props) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [typing, setTyping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const startNew = useCallback(async () => {
    setError("");
    setMessages([]);
    try {
      const conv = await api.startConversation();
      setConversationId(conv.id);
      setMessages([{ id: nextId++, from: "them", text: conv.greeting, time: now() }]);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    startNew();
  }, [startNew]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, typing]);

  const setStatus = (id: number, status: Status) =>
    setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, status } : m)));

  async function send(text: string) {
    text = text.trim();
    if (!text || !conversationId || busy) return;
    const id = nextId++;
    setDraft("");
    setError("");
    setBusy(true);
    setMessages((ms) => [...ms, { id, from: "me", text, time: now(), status: "sent" }]);

    const reply = api.sendMessage(conversationId, text);
    await wait(350);
    setStatus(id, "delivered");
    await wait(450);
    setStatus(id, "read");
    setTyping(true);

    try {
      const { replies } = await reply;
      for (const [i, r] of replies.entries()) {
        if (i > 0) {
          setTyping(true);
          await wait(700);
        }
        setTyping(false);
        setMessages((ms) => [...ms, { id: nextId++, from: "them", text: r, time: now() }]);
      }
    } catch (e) {
      setStatus(id, "error");
      setError((e as Error).message);
    } finally {
      setTyping(false);
      setBusy(false);
      onActivity();
      inputRef.current?.focus();
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    send(draft);
  }

  const name = settings.assistantName;
  const last = messages[messages.length - 1];

  return (
    <div className="wa">
      <aside className="wa-sidebar">
        <div className="wa-sidebar-head">
          <div className="wa-avatar wa-avatar-me">EU</div>
          <span className="wa-sidebar-title">Conversas</span>
        </div>
        <div className="wa-search">
          <Svg>{Icon.search}</Svg>
          <input placeholder="Pesquisar ou começar uma nova conversa" disabled />
        </div>
        <div className="wa-chatlist">
          <div className="wa-chatitem is-active">
            <div className="wa-avatar">{name.slice(0, 1).toUpperCase()}</div>
            <div className="wa-chatitem-body">
              <div className="wa-chatitem-top">
                <span className="wa-chatitem-name">{settings.storeName}</span>
                <span className="wa-chatitem-time">{last?.time}</span>
              </div>
              <div className="wa-chatitem-preview">
                {typing ? <span className="wa-typing-text">digitando...</span> : last?.text.replace(/[*_~]/g, "")}
              </div>
            </div>
          </div>
        </div>
      </aside>

      <div className="wa-chat">
        <header className="wa-header">
          <div className="wa-avatar">{name.slice(0, 1).toUpperCase()}</div>
          <div className="wa-header-info">
            <div className="wa-header-name">
              {settings.storeName} <span className="wa-verified" title="Conta comercial">✓</span>
            </div>
            <div className="wa-header-status">{typing ? "digitando..." : `${name} · online`}</div>
          </div>
          <button className="wa-icon-btn" onClick={startNew} title="Nova conversa" disabled={busy}>
            <Svg label="Nova conversa">{Icon.refresh}</Svg>
          </button>
          <button className="wa-icon-btn" title="Menu" disabled>
            <Svg>{Icon.menu}</Svg>
          </button>
        </header>

        <div className="wa-messages" ref={scrollRef}>
          <div className="wa-day">HOJE</div>
          <div className="wa-encryption">
            🔒 Esta é uma simulação. As respostas são geradas pela IA com o catálogo da loja em tempo real.
          </div>
          {messages.map((m, i) => {
            const firstOfGroup = messages[i - 1]?.from !== m.from;
            return (
              <div key={m.id} className={`wa-row ${m.from === "me" ? "is-me" : "is-them"}`}>
                <div className={`wa-bubble ${firstOfGroup ? "has-tail" : ""}`}>
                  <span className="wa-text">{formatWhatsApp(m.text)}</span>
                  <span className="wa-meta">
                    {m.time}
                    {m.from === "me" && <Checks status={m.status} />}
                  </span>
                </div>
              </div>
            );
          })}
          {typing && (
            <div className="wa-row is-them">
              <div className="wa-bubble wa-typing" aria-label={`${name} está digitando`}>
                <span />
                <span />
                <span />
              </div>
            </div>
          )}
          {error && <div className="wa-error">{error}</div>}
        </div>

        <div className="wa-suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => send(s)} disabled={busy || !conversationId}>
              {s}
            </button>
          ))}
        </div>

        <form className="wa-footer" onSubmit={onSubmit}>
          <button type="button" className="wa-icon-btn" tabIndex={-1} disabled>
            <Svg>{Icon.emoji}</Svg>
          </button>
          <button type="button" className="wa-icon-btn" tabIndex={-1} disabled>
            <Svg>{Icon.clip}</Svg>
          </button>
          <input
            ref={inputRef}
            className="wa-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Digite uma mensagem"
            maxLength={2000}
            autoFocus
          />
          <button className="wa-icon-btn wa-send" type="submit" disabled={busy || !draft.trim()} title="Enviar">
            <Svg label="Enviar">{draft.trim() ? Icon.send : Icon.mic}</Svg>
          </button>
        </form>
      </div>
    </div>
  );
}
