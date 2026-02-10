import fs from "fs";
import path from "path";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const VEC_PATH = path.join(process.cwd(), "kb", "sksscbs_vectors.json");
const vectors = JSON.parse(fs.readFileSync(VEC_PATH, "utf8"));

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function retrieve(query, k = 3) {
  const emb = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: query,
  });
  const qVec = emb.data[0].embedding;

  const scored = vectors.map((item) => ({
    id: item.id,
    title: item.title,
    text: item.text,
    score: cosineSim(qVec, item.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
