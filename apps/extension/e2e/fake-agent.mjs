#!/usr/bin/env node
// Stand-in for an agent CLI in automatic-mode e2e: reads the prompt from stdin, changes nothing,
// answers every annotation id with RESOLVED and the arguments it was started with.
let prompt = "";
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", () => {
  const ids = [...prompt.matchAll(/id=(a_[\w-]+)/g)].map((match) => match[1]);
  const args = process.argv.slice(2).filter((arg) => arg !== "-").join(" ");
  console.log([...new Set(ids)].map((id) => `### ${id}\nRESOLVED: fake agent ran with ${args.split(" -C ")[0]}`).join("\n\n"));
});
