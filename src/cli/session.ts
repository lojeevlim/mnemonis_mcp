import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError } from "./http.js";

export interface Session {
  /** The opaque `ms_` login session token. */
  token: string;
  /** ISO time the session ends if it is not used again (informational; the server decides). */
  expiresAt: string;
  /** The origin the session was issued for; it is never sent to any other host. */
  apiUrl: string;
}

/** ~/.mnemonis (dir 0700) holding cli-session.json (file 0600). Only the session token is stored, never the password. */
export function sessionPaths(home: string = homedir()): { dir: string; file: string } {
  const dir = join(home, ".mnemonis");
  return { dir, file: join(dir, "cli-session.json") };
}

const uid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);
const ownedByMe = (st: { uid: number }) => uid() === undefined || st.uid === uid();

/** Creates the dir if needed, refuses symlinks / foreign-owned dirs, and tightens the mode through the verified descriptor. */
function verifiedDir(dir: string, create: boolean): boolean {
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    if (create) throw new CliError("Cannot access the session directory.");
    return false;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new CliError("Refusing to use the session directory: it is a symlink or not a directory.");
  if (!ownedByMe(st)) throw new CliError("Refusing to use the session directory: it is not owned by the current user.");
  if (create) {
    // Open without following links and chmod the descriptor, so a swapped-in symlink cannot redirect the chmod.
    const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (!ownedByMe(fstatSync(fd))) throw new CliError("Refusing to use the session directory: it is not owned by the current user.");
      fchmodSync(fd, 0o700);
    } finally {
      closeSync(fd);
    }
  }
  return true;
}

export function saveSession(s: Session, home?: string): void {
  const { dir, file } = sessionPaths(home);
  verifiedDir(dir, true);
  const tmp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ token: s.token, expiresAt: s.expiresAt, apiUrl: s.apiUrl }), {
      mode: 0o600,
      flag: "wx",
    });
    chmodSync(tmp, 0o600); // we created it exclusively just above, so this cannot follow a planted link
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Returns null when there is no (valid) session. Throws when the file or its directory is unsafe. */
export function loadSession(home?: string): Session | null {
  const { dir, file } = sessionPaths(home);
  if (!verifiedDir(dir, false)) return null;
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CliError("Refusing to read the session file (it may be a symlink). Delete it and run login again.");
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new CliError("Refusing to read the session file: it is not a regular file. Delete it and run login again.");
    if (!ownedByMe(st)) throw new CliError("Refusing to read the session file: it is not owned by the current user. Delete it and run login again.");
    if ((st.mode & 0o077) !== 0) {
      throw new CliError(`Refusing to read the session file: permissions are ${(st.mode & 0o777).toString(8)} but must be 600. Delete it and run login again.`);
    }
    const v = JSON.parse(readFileSync(fd, "utf8")) as Partial<Session>;
    if (typeof v.token !== "string" || typeof v.expiresAt !== "string" || typeof v.apiUrl !== "string") return null;
    return { token: v.token, expiresAt: v.expiresAt, apiUrl: v.apiUrl };
  } catch (e) {
    if (e instanceof CliError) throw e;
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Returns true when a session file existed. Removes only the file (never follows a link). */
export function clearSession(home?: string): boolean {
  const { dir, file } = sessionPaths(home);
  if (!verifiedDir(dir, false)) return false;
  let had = true;
  try {
    lstatSync(file);
  } catch {
    had = false;
  }
  rmSync(file, { force: true });
  return had;
}
