import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaTool,
  BetaToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { pool } from "./db.js";
import { getSettings, listProducts, type Product, type StoreSettings, type Tone } from "./catalog.js";

const client = new Anthropic();
const MODEL = process.env.AI_MODEL ?? "claude-opus-5-5";
// Short WhatsApp replies don't need deep reasoning; raise to "medium" if answers get sloppy.
const EFFORT = (process.env.AI_EFFORT ?? "low") as "low" | "medium" | "high";
const MAX_TOOL_ROUNDS = 5;

const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const TONES: Record<Tone, string> = {
  amigavel:
    "Amigável e acolhedor: trate o cliente com carinho, use linguagem simples e no máximo um emoji por mensagem.",
  profissional:
    "Profissional e objetivo: linguagem cordial e formal, sem gírias e sem emojis.",
  descontraido:
    "Descontraído e animado: linguagem leve e informal, pode usar gírias leves e emojis com moderação.",
};

function formatCatalog(products: Product[]) {
  if (products.length === 0) return "(O catálogo está vazio no momento.)";
  return products
    .map((p) => {
      const sizes = p.sizes
        .map((s) => `${s.size}: ${s.stock > 0 ? `${s.stock} un.` : "ESGOTADO"}`)
        .join(" | ");
      return [
        `- ${p.name} (SKU ${p.sku})${p.category ? ` · ${p.category}` : ""} · ${brl(p.price)}`,
        p.description ? `  Descrição: ${p.description}` : null,
        `  Estoque por tamanho: ${sizes}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
}

/**
 * Built on every message from the live database, so any catalog or settings
 * change is reflected in the very next reply.
 */
export function buildSystemPrompt(s: StoreSettings, products: Product[], greeting: string) {
  return `Você é ${s.assistantName}, atendente virtual da ${s.storeName}, e conversa com clientes pelo WhatsApp.

# Tom de voz
${TONES[s.tone]}

# Dados da loja
- Endereço para retirada: ${s.address}
- Horário: ${s.openingHours}
- Entrega em casa: taxa de ${brl(s.deliveryFee)}. ${s.deliveryInfo}
- Retirada na loja: sem custo.

# Como responder
- Escreva como no WhatsApp: mensagens curtas, em português do Brasil, sem títulos nem tabelas. Use *negrito* do WhatsApp só para nome de produto e preço.
- Use apenas as informações do catálogo abaixo. Nunca invente produtos, preços, cores, tamanhos ou prazos. Se o cliente pedir algo que a loja não vende, diga isso com gentileza e sugira o item mais parecido do catálogo, se houver.
- Preços sempre no formato R$ 89,90.
- Quando um tamanho estiver ESGOTADO, diga que acabou e sugira proativamente os tamanhos disponíveis do mesmo produto ou um produto parecido que tenha estoque. Chame a ferramenta registrar_falta_estoque sempre que o cliente procurar um produto ou tamanho esgotado ou que a loja não vende.
- Não informe a quantidade exata em estoque, a não ser que o cliente pergunte. Se restarem 2 unidades ou menos, você pode dizer que são as últimas.
- Para fechar um pedido: confirme produto, tamanho e quantidade de cada item (liste os tamanhos disponíveis se o cliente não disse), mostre o subtotal, pergunte se ele prefere receber em casa ou retirar na loja, some a taxa de entrega se for o caso e mostre o total. Para entrega, peça o endereço. Só chame registrar_pedido depois que o cliente confirmar o resumo. Em seguida, informe o número do pedido e diga que o pagamento será combinado com a equipe da loja.
- Se não souber responder ou o cliente pedir para falar com uma pessoa, diga que vai encaminhar para a equipe da loja.

# Conversa até agora
Você já enviou esta saudação ao cliente no início da conversa: "${greeting}"

# Catálogo atualizado (fonte da verdade sobre preços e estoque)
${formatCatalog(products)}`;
}

const TOOLS: BetaTool[] = [
  {
    name: "registrar_falta_estoque",
    description:
      "Registra que o cliente procurou um produto ou tamanho esgotado, ou um produto que a loja não vende. Serve para as métricas do lojista. Não muda nada para o cliente.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        produto: { type: "string", description: "Nome do produto procurado, como o cliente pediu." },
        sku: { type: "string", description: "SKU do produto, ou string vazia se a loja não vende." },
        tamanho: { type: "string", description: "Tamanho procurado, ou string vazia." },
      },
      required: ["produto", "sku", "tamanho"],
      additionalProperties: false,
    },
  },
  {
    name: "registrar_pedido",
    description:
      "Registra o pedido confirmado pelo cliente e baixa o estoque. O sistema calcula o total oficial e devolve o número do pedido. Use só depois de o cliente confirmar o resumo.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        itens: {
          type: "array",
          items: {
            type: "object",
            properties: {
              sku: { type: "string" },
              tamanho: { type: "string" },
              quantidade: { type: "integer" },
            },
            required: ["sku", "tamanho", "quantidade"],
            additionalProperties: false,
          },
        },
        forma_entrega: { type: "string", enum: ["entrega", "retirada"] },
        endereco_entrega: { type: "string", description: "Endereço do cliente, ou string vazia na retirada." },
      },
      required: ["itens", "forma_entrega", "endereco_entrega"],
      additionalProperties: false,
    },
  },
];

async function logEvent(type: string, payload: object = {}) {
  await pool.query("INSERT INTO events (type, payload) VALUES ($1, $2)", [type, payload]);
}

interface OrderInput {
  itens: { sku: string; tamanho: string; quantidade: number }[];
  forma_entrega: "entrega" | "retirada";
  endereco_entrega: string;
}

async function placeOrder(conversationId: string, input: OrderInput, settings: StoreSettings) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const lines = [];
    let subtotal = 0;
    for (const item of input.itens) {
      if (!Number.isInteger(item.quantidade) || item.quantidade < 1)
        throw new Error(`Quantidade inválida para ${item.sku}.`);
      const { rows } = await db.query(
        `SELECT p.name, p.price, s.id AS size_id, s.size, s.stock
         FROM products p JOIN product_sizes s ON s.product_id = p.id
         WHERE p.sku = $1 AND upper(s.size) = upper($2) AND p.active
         FOR UPDATE OF s`,
        [item.sku, item.tamanho],
      );
      const row = rows[0];
      if (!row) throw new Error(`Produto ${item.sku} no tamanho ${item.tamanho} não existe no catálogo.`);
      if (row.stock < item.quantidade)
        throw new Error(`Estoque insuficiente: ${row.name} tamanho ${row.size} tem ${row.stock} unidade(s).`);
      await db.query("UPDATE product_sizes SET stock = stock - $1 WHERE id = $2", [item.quantidade, row.size_id]);
      subtotal += row.price * item.quantidade;
      lines.push({ sku: item.sku, nome: row.name, tamanho: row.size, quantidade: item.quantidade, preco: row.price });
    }
    if (lines.length === 0) throw new Error("O pedido não tem itens.");
    const fee = input.forma_entrega === "entrega" ? settings.deliveryFee : 0;
    const total = Math.round((subtotal + fee) * 100) / 100;
    const { rows } = await db.query(
      `INSERT INTO orders (conversation_id, items, total, fulfillment) VALUES ($1, $2, $3, $4) RETURNING id`,
      [conversationId, JSON.stringify(lines), total, input.forma_entrega],
    );
    await db.query("COMMIT");
    await logEvent("order", { orderId: rows[0].id, total });
    return {
      numero_pedido: rows[0].id,
      itens: lines,
      subtotal: brl(subtotal),
      taxa_entrega: brl(fee),
      total: brl(total),
      forma_entrega: input.forma_entrega,
      endereco: input.forma_entrega === "entrega" ? input.endereco_entrega : settings.address,
    };
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

async function runTool(
  name: string,
  input: unknown,
  conversationId: string,
  settings: StoreSettings,
): Promise<{ content: string; isError?: boolean }> {
  try {
    if (name === "registrar_falta_estoque") {
      await logEvent("stock_out", input as object);
      return { content: "Registrado." };
    }
    if (name === "registrar_pedido") {
      return { content: JSON.stringify(await placeOrder(conversationId, input as OrderInput, settings)) };
    }
    return { content: `Ferramenta desconhecida: ${name}`, isError: true };
  } catch (err) {
    return { content: (err as Error).message, isError: true };
  }
}

export async function startConversation(customerName = "Cliente") {
  const settings = await getSettings();
  const greeting = settings.greeting
    .replaceAll("{nome}", settings.assistantName)
    .replaceAll("{loja}", settings.storeName);
  const { rows } = await pool.query(
    "INSERT INTO conversations (customer_name, greeting) VALUES ($1, $2) RETURNING id, greeting, created_at",
    [customerName, greeting],
  );
  return { ...rows[0], assistantName: settings.assistantName, storeName: settings.storeName };
}

async function saveTurn(conversationId: string, role: "user" | "assistant", content: unknown) {
  await pool.query(
    "INSERT INTO conversation_turns (conversation_id, role, content) VALUES ($1, $2, $3)",
    [conversationId, role, JSON.stringify(content)],
  );
}

/** Sends one customer message and returns the bubbles Isis replies with. */
export async function chat(conversationId: string, text: string): Promise<string[]> {
  const conv = await pool.query("SELECT greeting FROM conversations WHERE id = $1", [conversationId]);
  if (!conv.rowCount) throw new Error("Conversa não encontrada.");

  const [settings, products, turns] = await Promise.all([
    getSettings(),
    listProducts({ onlyActive: true }),
    pool.query(
      "SELECT role, content FROM conversation_turns WHERE conversation_id = $1 ORDER BY id",
      [conversationId],
    ),
  ]);
  const system = buildSystemPrompt(settings, products, conv.rows[0].greeting);

  // History is append-only: earlier turns are replayed exactly as the API returned them.
  const messages: BetaMessageParam[] = turns.rows.map((r) => ({ role: r.role, content: r.content }));
  const userContent: BetaContentBlockParam[] = [{ type: "text", text }];
  messages.push({ role: "user", content: userContent });
  await saveTurn(conversationId, "user", userContent);
  await logEvent("message_in", { conversationId });

  const replies: string[] = [];
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: EFFORT },
      // Re-runs the request on Anthropic's recommended model if a safety classifier declines it.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      cache_control: { type: "ephemeral" },
      system,
      tools: TOOLS,
      messages,
    });

    if (response.stop_reason === "refusal") {
      replies.push("Desculpe, não consigo ajudar com isso por aqui. Posso te ajudar com algum produto da loja?");
      break;
    }

    messages.push({ role: "assistant", content: response.content as BetaContentBlockParam[] });
    await saveTurn(conversationId, "assistant", response.content);

    const said = response.content
      .flatMap((b) => (b.type === "text" ? [b.text.trim()] : []))
      .filter(Boolean)
      .join("\n\n");
    if (said) replies.push(said);

    if (response.stop_reason !== "tool_use") break;

    const results: BetaToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const r = await runTool(block.name, block.input, conversationId, settings);
      results.push({ type: "tool_result", tool_use_id: block.id, content: r.content, is_error: r.isError });
    }
    messages.push({ role: "user", content: results });
    await saveTurn(conversationId, "user", results);
  }

  if (replies.length === 0) replies.push("Só um instante, vou verificar com a equipe da loja.");
  await logEvent("message_out", { conversationId, count: replies.length });
  return replies;
}
