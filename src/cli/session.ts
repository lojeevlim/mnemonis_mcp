import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError } from "./supabase.js";

export interface Session {
  access_token: string;
  refresh_token: string;
  /** Unix seconds. */
  expires_at: number;
  /** Origins the session was issued for; it is never used or refreshed against any other host. */
  supabaseUrl: string;
  apiUrl: string;
}

/** ~/.mnemonis (dir 0700) holding cli-session.json (file 0600). Only the Supabase tokens are stored, never the password. */
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
    writeFileSync(tmp, JSON.stringify({ access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at, supabaseUrl: s.supabaseUrl, apiUrl: s.apiUrl }), {
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
    if (
      typeof v.access_token !== "string" ||
      typeof v.refresh_token !== "string" ||
      typeof v.expires_at !== "number" ||
      typeof v.supabaseUrl !== "string" ||
      typeof v.apiUrl !== "string"
    ) {
      return null;
    }
    return { access_token: v.access_token, refresh_token: v.refresh_token, expires_at: v.expires_at, supabaseUrl: v.supabaseUrl, apiUrl: v.apiUrl };
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
