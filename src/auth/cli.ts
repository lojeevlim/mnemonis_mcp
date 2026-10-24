import { homedir } from "node:os";
import { join } from "node:path";
import { claudeAddCommand, ensureToken, rotateToken, tokenPath } from "./token.js";

const dir = process.env.MNEMONIS_DATA_DIR || join(homedir(), ".mnemonis");
const port = Number.parseInt(process.env.PORT ?? "", 10) || 8787;

if (process.argv.includes("--rotate")) {
  const token = rotateToken(dir);
  console.log(`Token rotated (${tokenPath(dir)}). The old token stops working immediately.\n`);
  console.log(token);
  console.log(`\nRe-register with Claude Code:\n  claude mcp remove mnemonis\n  ${claudeAddCommand(token, port)}`);
} else {
  const { token, created } = ensureToken(dir);
  console.log(created ? `Created token (${tokenPath(dir)}).\n` : `Token file: ${tokenPath(dir)}\n`);
  console.log(token);
  console.log(`\nRegister with Claude Code:\n  ${claudeAddCommand(token, port)}`);
}
