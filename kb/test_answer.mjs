import { answerFromKB } from "./answer.mjs";

const q = process.argv.slice(2).join(" ") || "Do you have hostel facility?";
const ans = await answerFromKB(q);

console.log("\nQUESTION:", q);
console.log("\nANSWER:");
console.log(ans);
