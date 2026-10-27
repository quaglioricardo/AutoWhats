import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { pool } from "./db.js";
import { chat, startConversation } from "./ai.js";
import { getSettings } from "./catalog.js";

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
  return res.json().catch(() => null);
}

/** Plain phone numbers for regular chats; the full JID for privacy (@lid) contacts. */
const destination = (jid: string) => (jid.endsWith("@s.whatsapp.net") ? jid.split("@")[0] : jid);

// Texts Isis sent recently. The echo of an API send does not always carry the id the send returned,
// so the text is a second way to recognize it and not mistake it for the shopkeeper.
const recentlySent = new Map<string, number>();
const SENT_MEMORY_MS = 10 * 60 * 1000;

function rememberSent(text: string) {
  const now = Date.now();
  for (const [t, at] of recentlySent) if (now - at > SENT_MEMORY_MS) recentlySent.delete(t);
  recentlySent.set(text.trim(), now);
}

const sentByIsis = (text: string) => {
  const at = recentlySent.get(text.trim());
  return at !== undefined && Date.now() - at <= SENT_MEMORY_MS;
};

// The shopkeeper types this in a chat to hand it back to Isis right away.
const RESUME_COMMAND = "#isis";

export async function sendText(jid: string, text: string) {
  const number = destination(jid);
  for (let i = 0; i < text.length; i += 4000) {
    const chunk = text.slice(i, i + 4000);
    rememberSent(chunk);
    const sent = await evolution("/message/sendText", config().v1 ? { number, textMessage: { text: chunk } } : { number, text: chunk });
    // Remember our own messages, so their echo on the webhook is not mistaken for the shopkeeper typing.
    if (sent?.key?.id)
      await pool.query("INSERT INTO whatsapp_messages (id, wa_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [sent.key.id, jid]);
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

async function findOrStartConversation(jid: string, profileName: string, forceNew = false) {
  if (forceNew) return startWhatsappConversation(jid, profileName);
  const { rows } = await pool.query(
    `SELECT c.id FROM conversations c
     WHERE c.channel = 'whatsapp' AND c.whatsapp_id = $1
       AND COALESCE((SELECT max(t.created_at) FROM conversation_turns t WHERE t.conversation_id = c.id), c.created_at)
           > now() - make_interval(hours => $2)
     ORDER BY c.created_at DESC LIMIT 1`,
    [jid, CONVERSATION_IDLE_HOURS],
  );
  if (rows[0]) return { id: rows[0].id as string, greeting: null };
  return startWhatsappConversation(jid, profileName);
}

async function startWhatsappConversation(jid: string, profileName: string) {
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

/** Brazilian numbers compared by area code + last 8 digits, so "+55", the extra 9 and formatting don't matter. */
function phoneKey(value: string) {
  let digits = value.split("@")[0].replace(/\D/g, "");
  if (digits.length >= 12 && digits.startsWith("55")) digits = digits.slice(2);
  return digits.length >= 10 ? digits.slice(0, 2) + digits.slice(-8) : digits;
}

function isIgnored(jid: string, ignoredNumbers: string) {
  const key = phoneKey(jid);
  return ignoredNumbers
    .split(/[\n,;]+/)
    .map(phoneKey)
    .some((n) => n.length >= 8 && n === key);
}

async function pausedUntil(jid: string): Promise<Date | null> {
  const { rows } = await pool.query("SELECT until FROM whatsapp_pauses WHERE wa_id = $1 AND until > now()", [jid]);
  return rows[0]?.until ?? null;
}

/** A message sent from the store's phone that Isis did not send: the shopkeeper took over the chat. */
async function handleOwnMessage(data: UpsertData) {
  const jid = customerJid(data.key);
  // The echo can beat the sendText response that records the id; give it a moment.
  await new Promise((r) => setTimeout(r, 1500));
  const fresh = await pool.query(
    "INSERT INTO whatsapp_messages (id, wa_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [data.key.id, jid],
  );
  if (!fresh.rowCount) return; // one of Isis's own replies
  const text = messageText(data.message)?.trim() ?? "";
  if (text && sentByIsis(text)) return;
  const masked = `${jid.split("@")[0].slice(0, -4)}****`;
  if (text.toLowerCase() === RESUME_COMMAND) {
    await pool.query("DELETE FROM whatsapp_pauses WHERE wa_id = $1", [jid]);
    console.log(`WhatsApp: lojista devolveu a conversa com ${masked} para a Isis.`);
    return;
  }
  const minutes = (await getSettings()).humanPauseMinutes;
  if (!minutes) return;
  await pool.query(
    `INSERT INTO whatsapp_pauses (wa_id, until) VALUES ($1, now() + make_interval(mins => $2))
     ON CONFLICT (wa_id) DO UPDATE SET until = EXCLUDED.until`,
    [jid, minutes],
  );
  console.log(
    `WhatsApp: lojista respondeu ${masked} pelo celular, Isis pausada por ${minutes} min nessa conversa (envie ${RESUME_COMMAND} na conversa para liberar).`,
  );
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

  const masked = `${jid.split("@")[0].slice(0, -4)}****`;
  if (isIgnored(jid, (await getSettings()).ignoredNumbers)) {
    console.log(`WhatsApp: ${masked} está na lista de números ignorados.`);
    return;
  }
  if (await pausedUntil(jid)) {
    console.log(`WhatsApp: conversa com ${masked} em atendimento humano, Isis não respondeu.`);
    return;
  }

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
  console.log(`WhatsApp: mensagem de ${masked} (${text.length} caracteres)`);

  let replies: string[];
  try {
    replies = await chat(conv.id, text.slice(0, 2000));
  } catch (err) {
    console.error("WhatsApp: falha ao gerar resposta:", err);
    replies = ["Desculpe, tive um problema para consultar o estoque agora. Pode tentar de novo em instantes?"];
    // A request the API rejects (400) fails the same way on every message while the old history is replayed,
    // so the customer gets a fresh conversation instead of the same error forever.
    if (err instanceof Anthropic.BadRequestError) {
      console.warn(`WhatsApp: histórico da conversa com ${masked} foi recusado pela IA, começando uma conversa nova.`);
      try {
        const fresh = await findOrStartConversation(jid, data.pushName ?? "", true);
        replies = await chat(fresh.id, text.slice(0, 2000));
      } catch (retryErr) {
        console.error("WhatsApp: falha também na conversa nova:", retryErr);
      }
    }
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
    if (!data?.key?.id) continue;
    // Only private chats: skip groups, status updates and channels.
    if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast" || jid.endsWith("@newsletter")) continue;
    // Same queue for both directions: the echo of a reply Isis is still sending waits until it is recorded.
    enqueue(customerJid(data.key), () => (data.key.fromMe ? handleOwnMessage(data) : handleMessage(data)));
  }
}
