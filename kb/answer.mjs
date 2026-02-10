import OpenAI from "openai";
import { retrieve } from "./retrieve.mjs";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function answerFromKB(userQuestion) {
  const top = await retrieve(userQuestion, 3);

  const context = top
    .map((x, i) => `Source ${i + 1}: ${x.title}\n${x.text}`)
    .join("\n\n");

  const system = `
You are an admissions assistant for SKSSCBS.

RULES:
- Answer ONLY using the provided Sources.
- Keep answers short (2–3 sentences).
- If answer not found, say:
"I may not have that information in my knowledge base yet."
Then share:
admissions@somaiya.edu
+91 7028233777
`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: `User question: ${userQuestion}\n\nSOURCES:\n${context}`,
      },
    ],
  });

  return resp.choices[0].message.content;
}
