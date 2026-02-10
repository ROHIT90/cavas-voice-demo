import fs from "fs";
import path from "path";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const KB_PATH = path.join(process.cwd(), "kb", "sksscbs_kb.json");
const OUT_PATH = path.join(process.cwd(), "kb", "sksscbs_vectors.json");

const kb = JSON.parse(fs.readFileSync(KB_PATH, "utf8"));

async function run() {
  const out = [];
  for (const item of kb) {
    const input = `${item.title}\n${item.text}`;
    const emb = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input
    });

    out.push({ ...item, embedding: emb.data[0].embedding });
    console.log("Embedded:", item.id);
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log("Saved:", OUT_PATH);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
