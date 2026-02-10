import fs from "fs";
import path from "path";
import * as pdfParse from "pdf-parse";
import mammoth from "mammoth";
import OpenAI from "openai";


const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const KB_DIR = path.join(process.cwd(), "kb");
const KB_JSON = path.join(KB_DIR, "kb.json");
const KB_VECTORS = path.join(KB_DIR, "kb_vectors.json");

// ---------- Text extract ----------
export async function extractTextFromBuffer(buffer, originalName = "") {
  const name = originalName.toLowerCase();

  if (name.endsWith(".pdf")) {
  const data = await pdfParse.default(buffer);
  return (data.text || "").trim();
  }

  if (name.endsWith(".docx")) {
    const out = await mammoth.extractRawText({ buffer });
    return (out.value || "").trim();
  }

  // fallback: treat as txt/markdown
  return buffer.toString("utf8").trim();
}

// ---------- Chunking ----------
export function chunkText(text, opts = {}) {
  const {
    maxChars = 900,   // small chunk = faster + better retrieval
    overlap = 120
  } = opts;

  const clean = String(text || "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const chunks = [];
  let i = 0;

  while (i < clean.length) {
    const end = Math.min(i + maxChars, clean.length);
    const slice = clean.slice(i, end);
    chunks.push(slice);
    if (end === clean.length) break;
    i = Math.max(0, end - overlap);
  }

  return chunks
    .map((c) => c.trim())
    .filter((c) => c.length >= 40); // drop tiny junk
}

// ---------- Build KB + vectors ----------
export async function buildKbFromText({ sourceName, text }) {
  if (!fs.existsSync(KB_DIR)) fs.mkdirSync(KB_DIR, { recursive: true });

  const chunks = chunkText(text);
  if (!chunks.length) throw new Error("No usable text found after parsing/chunking.");

  // Create KB items
  const kb = chunks.map((chunk, idx) => ({
    id: `${Date.now()}_${idx}`,
    title: `${sourceName} - chunk ${idx + 1}`,
    text: chunk,
    source: sourceName,
  }));

  // Embed in batches (faster + safer)
  const vectors = [];
  const batchSize = 32;

  for (let i = 0; i < kb.length; i += batchSize) {
    const batch = kb.slice(i, i + batchSize);
    const inputs = batch.map((x) => `${x.title}\n${x.text}`);

    const emb = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: inputs,
    });

    for (let j = 0; j < batch.length; j++) {
      vectors.push({
        ...batch[j],
        embedding: emb.data[j].embedding,
      });
    }
  }

  fs.writeFileSync(KB_JSON, JSON.stringify(kb, null, 2));
  fs.writeFileSync(KB_VECTORS, JSON.stringify(vectors, null, 2));

  return {
    kbCount: kb.length,
    kbJson: KB_JSON,
    kbVectors: KB_VECTORS,
  };
}
