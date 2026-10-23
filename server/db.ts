import pg from "pg";

// Postgres returns NUMERIC as string by default; prices fit safely in a JS number.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => parseFloat(v));

export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://autowhats:autowhats@localhost:5432/autowhats",
});

export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id           SERIAL PRIMARY KEY,
      sku          TEXT NOT NULL UNIQUE,
      name         TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      category     TEXT NOT NULL DEFAULT '',
      price        NUMERIC(10,2) NOT NULL CHECK (price >= 0),
      active       BOOLEAN NOT NULL DEFAULT TRUE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS product_sizes (
      id          SERIAL PRIMARY KEY,
      product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      size        TEXT NOT NULL,
      stock       INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
      position    INTEGER NOT NULL DEFAULT 0,
      UNIQUE (product_id, size)
    );

    CREATE TABLE IF NOT EXISTS settings (
      id     INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      data   JSONB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_name  TEXT NOT NULL DEFAULT 'Cliente',
      greeting       TEXT NOT NULL DEFAULT '',
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Full API turns (content blocks, tool calls, thinking) are stored so the
    -- history can be replayed to Claude unchanged on every request.
    CREATE TABLE IF NOT EXISTS conversation_turns (
      id               SERIAL PRIMARY KEY,
      conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role             TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content          JSONB NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id               SERIAL PRIMARY KEY,
      conversation_id  UUID REFERENCES conversations(id) ON DELETE SET NULL,
      items            JSONB NOT NULL,
      total            NUMERIC(10,2) NOT NULL,
      fulfillment      TEXT NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS events (
      id          SERIAL PRIMARY KEY,
      type        TEXT NOT NULL,
      payload     JSONB NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS events_type_idx ON events(type);

    -- Canal da conversa: 'simulador' (painel) ou 'whatsapp' (Cloud API da Meta).
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'simulador';
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS whatsapp_id TEXT;
    CREATE INDEX IF NOT EXISTS conversations_whatsapp_idx ON conversations(whatsapp_id) WHERE whatsapp_id IS NOT NULL;

    -- Mensagens já recebidas do WhatsApp, para não responder duas vezes a reenvios da Meta.
    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id           TEXT PRIMARY KEY,
      wa_id        TEXT NOT NULL,
      received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}
