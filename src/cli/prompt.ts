import { createInterface } from "node:readline";
import { Writable } from "node:stream";

export interface PromptIo {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream;
}

/** Reads one line from a TTY without echoing it. Refuses non-interactive input (the password is never taken from argv or pipes). */
export function readHidden(question: string, io: PromptIo): Promise<string> {
  if (!io.input.isTTY) return Promise.reject(new Error("A password can only be entered interactively (TTY); it is never read from arguments or pipes."));
  let muted = false;
  const sink = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) io.output.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: io.input, output: sink, terminal: true });
  return new Promise<string>((resolve, reject) => {
    let answered = false;
    rl.on("close", () => {
      if (!answered) reject(new Error("Input closed before a password was entered."));
    });
    io.output.write(question);
    muted = true;
    rl.question("", (answer) => {
      answered = true;
      muted = false;
      io.output.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}
