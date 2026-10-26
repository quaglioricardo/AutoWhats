import crypto from "node:crypto";
import { pool } from "./db.js";
import { chat, startConversation } from "./ai.js";

/**
 * WhatsApp channel through Evolution API: the instance posts every new message
 * to our webhook and we answer with the same engine used by the simulator.
 */

// A customer who comes back after this long starts a fresh conversation (and history).
const CONVERSATION_IDLE_HOURS = 24;

const config = () => ({
  url: (process.env.EVOLUTION_API_URL ?? "").replace(/\/+$/, ""),
  apiKey: process.env.EVOLUTION_API_KEY ?? "",
  instance: process.env.EVOLUTION_INSTANCE ?? "",
  webhookToken: process.env.EVOLUTION_WEBHOOK_TOKEN ?? "",
  // v2 (default) sends { number, text }; v1 expects { number, textMessage: { text } }.
  v1: process.env.EVOLUTION_API_VERSION === "v1",
});

export const whatsappEnabled = () => {
  const c = config();
  return Boolean(c.url && c.apiKey && c.instance);
};

/** Evolution does not sign webhooks, so the URL carries a secret token we compare. */
export function validWebhookToken(token: unknown): boolean {
  const expected = config().webhookToken;
  if (!expected) return true; // optional while testing; recommended in production
  const given = String(token ?? "");
  return (
    given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))
  );
}

async function evolution(path: string, body: object) {
  const c = config();
  const res = await fetch(`${c.url}${path}/${encodeURIComponent(c.instance)}`, {
    method: "POST",
    headers: { apikey: c.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Evolution API ${res.status} em ${path}: ${detail.slice(0, 500)}`);
  }
}

/** Plain phone numbers for regular chats; the full JID for privacy (@lid) contacts. */
const destination = (jid: string) => (jid.endsWith("@s.whatsapp.net") ? jid.split("@")[0] : jid);

export async function sendText(jid: string, text: string) {
  const number = destination(jid);
  for (let i = 0; i < text.length; i += 4000) {
    const chunk = text.slice(i, i + 4000);
    await evolution("/message/sendText", config().v1 ? { number, textMessage: { text: chunk } } : { number, text: chunk });
  }
}

/** Blue checks and "digitando..." while Isis thinks. Failures here never block the reply. */
async function markReadAndTyping(key: MessageKey) {
  const number = destination(customerJid(key));
  await evolution("/chat/markMessageAsRead", {
    readMessages: [{ remoteJid: key.remoteJid, fromMe: false, id: key.id }],
  }).catch((err) => console.warn("WhatsApp: não foi possível marcar como lida:", (err as Error).message));
  await evolution("/chat/sendPresence", config().v1
    ? { number, options: { presence: "composing", delay: 1200 } }
    : { number, presence: "composing", delay: 1200 },
  ).catch((err) => console.warn("WhatsApp: não foi possível mostrar 'digitando':", (err as Error).message));
}

async function findOrStartConversation(jid: string, profileName: string) {
  const { rows } = await pool.query(
    `SELECT c.id FROM conversations c
     WHERE c.channel = 'whatsapp' AND c.whatsapp_id = $1
       AND COALESCE((SELECT max(t.created_at) FROM conversation_turns t WHERE t.conversation_id = c.id), c.created_at)
           > now() - make_interval(hours => $2)
     ORDER BY c.created_at DESC LIMIT 1`,
    [jid, CONVERSATION_IDLE_HOURS],
  );
  if (rows[0]) return { id: rows[0].id as string, greeting: null };
  const conv = await startConversation(profileName || "Cliente");
  await pool.query("UPDATE conversations SET channel = 'whatsapp', whatsapp_id = $2 WHERE id = $1", [conv.id, jid]);
  return { id: conv.id as string, greeting: conv.greeting as string };
}

interface MessageKey {
  remoteJid: string;
  // Newer WhatsApp versions address chats by an anonymous @lid; Evolution then sends the phone JID here.
  remoteJidAlt?: string;
  senderPn?: string;
  fromMe?: boolean;
  id: string;
}

/** The phone JID when WhatsApp gives one, so replies go to the number and not the @lid alias. */
const customerJid = (key: MessageKey) =>
  [key.remoteJidAlt, key.senderPn].find((j) => j?.endsWith("@s.whatsapp.net")) ?? key.remoteJid;

interface UpsertData {
  key: MessageKey;
  pushName?: string;
  message?: Record<string, any>;
}

function messageText(message: Record<string, any> | undefined): string | null {
  if (!message) return null;
  return (
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.buttonsResponseMessage?.selectedDisplayText ??
    message.listResponseMessage?.title ??
    message.templateButtonReplyMessage?.selectedDisplayText ??
    message.imageMessage?.caption ??
    null
  );
}

// Messages from the same customer are answered one at a time, in order.
const queues = new Map<string, Promise<void>>();

function enqueue(jid: string, job: () => Promise<void>) {
  const previous = queues.get(jid) ?? Promise.resolve();
  const next = previous.then(job).catch((err) => console.error(`WhatsApp (${jid}):`, err));
  queues.set(jid, next);
  next.finally(() => {
    if (queues.get(jid) === next) queues.delete(jid);
  });
}

async function handleMessage(data: UpsertData) {
  const { key } = data;
  const jid = customerJid(key);
  // Evolution may deliver the same message more than once; answer each one only once.
  const fresh = await pool.query(
    "INSERT INTO whatsapp_messages (id, wa_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [key.id, jid],
  );
  if (!fresh.rowCount) return;

  const text = messageText(data.message)?.trim();
  if (!text) {
    // Ignore protocol noise (reactions, edits, deletions); answer real media with a hint.
    const media = ["audioMessage", "imageMessage", "videoMessage", "stickerMessage", "documentMessage"];
    if (Object.keys(data.message ?? {}).some((k) => media.includes(k)))
      await sendText(jid, "Por enquanto eu só consigo ler mensagens de texto 😊 Pode me escrever o que você procura?");
    return;
  }

  await markReadAndTyping(key);
  const conv = await findOrStartConversation(jid, data.pushName ?? "");
  const started = Date.now();
  console.log(`WhatsApp: mensagem de ${jid.split("@")[0].slice(0, -4)}**** (${text.length} caracteres)`);

  let replies: string[];
  try {
    replies = await chat(conv.id, text.slice(0, 2000));
  } catch (err) {
    console.error("WhatsApp: falha ao gerar resposta:", err);
    replies = ["Desculpe, tive um problema para consultar o estoque agora. Pode tentar de novo em instantes?"];
  }
  // The greeting only goes out when the customer starts a new conversation.
  if (conv.greeting) replies.unshift(conv.greeting);
  for (const r of replies) await sendText(jid, r);
  console.log(`WhatsApp: ${replies.length} resposta(s) em ${Date.now() - started} ms`);
}

/** Entry point for the webhook. Returns right away; replies are sent in the background. */
export function processWebhook(body: any) {
  const event = String(body?.event ?? "").toLowerCase().replace("_", ".");
  console.log(`WhatsApp: webhook recebido (evento ${body?.event ?? "?"}, instância ${body?.instance ?? "?"})`);
  if (event !== "messages.upsert") return;
  if (body.instance && body.instance !== config().instance) {
    console.warn(`WhatsApp: ignorado, a instância "${body.instance}" não é a configurada ("${config().instance}").`);
    return;
  }

  // v2 sends one message in `data`; some setups batch them in `data.messages`.
  const items: UpsertData[] = Array.isArray(body.data?.messages) ? body.data.messages : [body.data];
  for (const data of items) {
    const jid = data?.key?.remoteJid ?? "";
    if (!data?.key?.id || data.key.fromMe) continue;
    // Only private chats: skip groups, status updates and channels.
    if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast" || jid.endsWith("@newsletter")) continue;
    enqueue(customerJid(data.key), () => handleMessage(data));
  }
}
