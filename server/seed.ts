import { pool } from "./db.js";
import { upsertProducts, type ProductInput } from "./catalog.js";

const SAMPLE: ProductInput[] = [
  {
    sku: "CAM-CLASSIC", name: "Camiseta Classic", category: "Camisetas", price: 89.9, active: true,
    description: "Camiseta 100% algodão, gola careca, modelagem regular. Cores: branca, preta e azul-marinho.",
    sizes: [{ size: "P", stock: 5 }, { size: "M", stock: 8 }, { size: "G", stock: 0 }, { size: "GG", stock: 3 }],
  },
  {
    sku: "TEN-AIRSPORT", name: "Tênis Air Sport", category: "Calçados", price: 349.9, active: true,
    description: "Tênis de corrida com amortecimento a ar e cabedal em mesh respirável. Cor: preto com detalhes brancos.",
    sizes: [{ size: "38", stock: 2 }, { size: "39", stock: 0 }, { size: "40", stock: 4 }, { size: "41", stock: 3 }, { size: "42", stock: 1 }],
  },
  {
    sku: "CAL-JEANS-SLIM", name: "Calça Jeans Slim", category: "Calças", price: 199.9, active: true,
    description: "Jeans com elastano, lavagem média, corte slim.",
    sizes: [{ size: "38", stock: 6 }, { size: "40", stock: 4 }, { size: "42", stock: 0 }, { size: "44", stock: 2 }],
  },
  {
    sku: "MOL-CANGURU", name: "Moletom Canguru", category: "Moletons", price: 229.9, active: true,
    description: "Moletom flanelado com capuz e bolso canguru. Cor: cinza mescla.",
    sizes: [{ size: "P", stock: 3 }, { size: "M", stock: 0 }, { size: "G", stock: 5 }, { size: "GG", stock: 2 }],
  },
  {
    sku: "VES-MIDI-FLORAL", name: "Vestido Midi Floral", category: "Vestidos", price: 179.9, active: true,
    description: "Vestido midi em viscose com estampa floral e alças reguláveis.",
    sizes: [{ size: "P", stock: 4 }, { size: "M", stock: 2 }, { size: "G", stock: 1 }],
  },
  {
    sku: "MEI-ESPORTIVA-3", name: "Kit Meia Esportiva (3 pares)", category: "Acessórios", price: 39.9, active: true,
    description: "Kit com 3 pares de meias cano curto, algodão com elastano.",
    sizes: [{ size: "Único", stock: 20 }],
  },
];

/** Loads the sample catalog only when the store has no products yet. */
export async function seedIfEmpty() {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM products");
  if (rows[0].n > 0) return false;
  await upsertProducts(SAMPLE);
  return true;
}
