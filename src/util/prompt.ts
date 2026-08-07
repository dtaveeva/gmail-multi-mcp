import readline from "node:readline/promises";
import { Writable } from "node:stream";

/**
 * Read a secret without echoing it.
 *
 * readline has no built-in masking, so the interface is given a Writable that
 * drops everything written while the answer is being typed. The prompt itself
 * is written before muting, so the user still sees what is being asked.
 */
export async function promptSecret(prompt: string): Promise<string> {
  let muted = false;

  const sink = new Writable({
    write(chunk: Buffer | string, _encoding: unknown, done: () => void) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: sink,
    terminal: true,
  });

  try {
    const pending = rl.question(prompt);
    muted = true;
    return await pending;
  } finally {
    muted = false;
    rl.close();
    process.stdout.write("\n");
  }
}
