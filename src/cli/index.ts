import { loadCliEnv } from "./env.js";
import { runCli } from "./run.js";

process.exitCode = await runCli(process.argv.slice(2), {
  env: loadCliEnv(process.env),
  out: (l) => console.log(l),
  err: (l) => console.error(l),
});
