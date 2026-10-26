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

export interface Metrics {
  messagesIn: number;
  messagesOut: number;
  stockOutChecks: number;
  orders: number;
  revenue: number;
  conversations: number;
  whatsappConversations: number;
  topStockOuts: { produto: string; tamanho: string | null; vezes: number }[];
  recentOrders: {
    id: number;
    items: { nome: string; tamanho: string; quantidade: number }[];
    total: number;
    fulfillment: "entrega" | "retirada";
    created_at: string;
  }[];
}

export interface ConversationStart {
  id: string;
  greeting: string;
  assistantName: string;
  storeName: string;
  created_at: string;
}
