import { retrieve } from "./retrieve.mjs";

const q = process.argv.slice(2).join(" ") || "Do you have hostel facility?";
const top = await retrieve(q, 3);

console.log("QUESTION:", q);
console.log("TOP MATCHES:");
for (const r of top) {
  console.log(`- ${r.title} (score ${r.score.toFixed(3)})`);
  console.log(`  ${r.text}`);
}
