#!/usr/bin/env node
// Move the agents' profile off the macOS login keychain, once (MX-1293).
//
// Chromium on macOS encrypts cookies, saved passwords and tokens with a key
// kept in the login keychain ("Brave Safe Storage" for Brave). The agents'
// browser now runs from its own copy of the app with `--use-mock-keychain`
// (see src/agents-app.ts), whose key is the constant "mock_password" —
// measured 2026-09-26 by setting a cookie under the flag and decrypting it.
// Data already in the profile is still under the keychain key, so this
// re-encrypts every such value, then writes the `bb-keychain` marker that
// switches the plugin over. Without the marker the plugin launches as before.
//
// Usage (the agents' browser must be closed: `bb plugin run browser quit`):
//   node scripts/migrate-keychain.mjs --profile <dir> [--service "Brave Safe Storage"]
//   node scripts/migrate-keychain.mjs --profile <dir> --count     # no keychain read
//
// The keychain key is read once, held in this process's memory, and never
// printed or written anywhere. macOS asks before handing it over: "Allow" is
// enough; "Always Allow" would let this tool read it again without asking.
//
// Nothing is changed in place. The profile is cloned (APFS, near-free), the
// clone is migrated and verified, and only then swapped in; the original is
// kept beside it as `<profile>.pre-mock-<timestamp>`.
import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, pbkdf2Sync } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const PREFIX = Buffer.from("v10");
const IV = Buffer.alloc(16, 0x20);
const MOCK_PASSWORD = "mock_password";
const MARKER = "bb-keychain";
const LOCK = "bb-keychain-migrating";

const keyFrom = (password) => pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");

function decrypt(key, value) {
  try {
    const d = createDecipheriv("aes-128-cbc", key, IV);
    return Buffer.concat([d.update(value.subarray(3)), d.final()]);
  } catch {
    return null;
  }
}

function encrypt(key, plain) {
  const c = createCipheriv("aes-128-cbc", key, IV);
  return Buffer.concat([PREFIX, c.update(plain), c.final()]);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

function die(message) {
  console.error(`migrate-keychain: ${message}`);
  process.exit(1);
}

/** A refusal inside the locked section: thrown, so `finally` cleans up. */
class Refusal extends Error {}

/** Every SQLite file under dir, by content rather than name. */
function sqliteFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sqliteFiles(path));
    else if (entry.isFile() && lstatSync(path).size >= 100) {
      const fd = openSync(path, "r");
      const head = Buffer.alloc(16);
      readSync(fd, head, 0, 16, 0);
      closeSync(fd);
      if (head.toString("latin1") === "SQLite format 3\0") out.push(path);
    }
  }
  return out;
}

/**
 * Visit every value starting "v10" in every table of every database.
 * `visit(buffer)` returns a replacement buffer, or null to leave it.
 */
function eachEncrypted(dir, visit, write) {
  const tally = [];
  for (const file of sqliteFiles(dir)) {
    const db = new DatabaseSync(file);
    if (write) db.exec("BEGIN");
    for (const { name: table } of db.prepare("select name from sqlite_master where type='table'").all()) {
      const cols = db.prepare(`pragma table_info("${table}")`).all().map((c) => c.name);
      for (const col of cols) {
        let rows;
        try {
          rows = db
            .prepare(`select rowid as r, "${col}" as v from "${table}" where typeof("${col}")='blob' and substr("${col}",1,3)=x'763130'`)
            .all();
        } catch {
          continue; // WITHOUT ROWID or a virtual table: nothing of ours
        }
        if (!rows.length) continue;
        const t = { db: file.slice(dir.length + 1), table, col, found: rows.length, changed: 0, undecryptable: 0 };
        for (const { r, v } of rows) {
          const next = visit(Buffer.from(v));
          if (next === null) t.undecryptable += 1;
          else if (next !== false) {
            if (write) db.prepare(`update "${table}" set "${col}"=? where rowid=?`).run(next, r);
            t.changed += 1;
          }
        }
        tally.push(t);
      }
    }
    if (write) db.exec("COMMIT");
    db.close();
  }
  return tally;
}

/** Cookies that decrypt under `key` — the "logged-in cookie count". */
function readableCookies(profile, key) {
  const file = join(profile, "Default", "Cookies");
  if (!existsSync(file)) return 0;
  const db = new DatabaseSync(file, { readOnly: true });
  let n = 0;
  for (const { v } of db.prepare("select encrypted_value as v from cookies where length(encrypted_value) > 0").all()) {
    if (decrypt(key, Buffer.from(v)) !== null) n += 1;
  }
  db.close();
  return n;
}

const profile = arg("--profile");
if (!profile || !existsSync(profile)) die("--profile <dir> must name the agents' profile directory");

if (process.argv.includes("--count")) {
  console.log(JSON.stringify({ profile, cookiesReadableWithMockKey: readableCookies(profile, keyFrom(MOCK_PASSWORD)) }));
  process.exit(0);
}

if (existsSync(join(profile, MARKER)) && readFileSync(join(profile, MARKER), "utf8").trim() === "mock") {
  die("this profile is already on the mock keychain; nothing to do");
}
/**
 * Whether a browser is on this profile: its lock, or a DevTools port that
 * answers. The lock alone is not enough — measured 2026-09-26, a freshly
 * launched browser already answers on its port before SingletonLock appears.
 */
async function browserHolds() {
  if (existsSync(join(profile, "SingletonLock"))) return true;
  try {
    const port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0].trim();
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Ask the agents' browser to close, over its own DevTools port. */
async function closeBrowser() {
  let port;
  try {
    port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0].trim();
  } catch {
    return;
  }
  try {
    const version = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    const socket = new WebSocket((await version.json()).webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    socket.close();
  } catch {
    // not answering: nothing to close
  }
}

// THE LOCK COMES FIRST, and names this process. While it is held the plugin
// refuses to launch the agents' browser — including its own minute-by-minute
// sweep, which is what relaunched it mid-migration twice on 2026-09-26
// (MX-1293). A run killed while it waits on the keychain prompt cannot clean
// up (the wait is a blocking call), so the plugin treats a lock whose process
// is gone as stale and removes it: a dead migration never blocks the browser.
const lockFile = join(profile, LOCK);
try {
  writeFileSync(lockFile, `${process.pid}\n`, { flag: "wx" });
} catch {
  const holder = Number(readFileSync(lockFile, "utf8").trim());
  if (Number.isInteger(holder) && holder > 0 && alive(holder)) die(`another migration (pid ${holder}) holds this profile`);
  writeFileSync(lockFile, `${process.pid}\n`);
}
const staging = `${profile}.migrating`;
let swapped = false;
try {
  let oldKey;
  try {
    const service = arg("--service") ?? "Brave Safe Storage";
    // TEST ONLY: the suite supplies a synthetic key so it never touches a real
    // keychain. Nothing in normal use sets it.
    const password =
      process.env.MIGRATE_KEYCHAIN_TEST_PASSWORD ??
      // stdout is captured into memory and never echoed; stderr stays visible.
      execFileSync("security", ["find-generic-password", "-w", "-s", service], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      }).trimEnd();
    oldKey = keyFrom(password);
  } catch {
    throw new Refusal("could not read the keychain key (was the prompt denied?) — nothing was changed");
  }

  // Close the agents' browser HERE, under the lock, so nothing can start it
  // again between the close and the copy. Then refuse unless it is gone: a
  // copy taken under a live browser is a copy of files being rewritten.
  await closeBrowser();
  for (let i = 0; i < 60 && (await browserHolds()); i++) await new Promise((r) => setTimeout(r, 500));
  if (await browserHolds()) throw new Refusal("the agents' browser is still running on this profile (SingletonLock) — nothing was changed");
  const mockKey = keyFrom(MOCK_PASSWORD);

  const before = readableCookies(profile, oldKey);
  rmSync(staging, { recursive: true, force: true });
  execFileSync("cp", ["-c", "-R", profile, staging]);

  const migrated = eachEncrypted(staging, (v) => {
    const plain = decrypt(oldKey, v);
    return plain === null ? null : encrypt(mockKey, plain);
  }, true);

  // Verify on the staged copy before anything is swapped: everything changed
  // must now read under the mock key, and the cookie count must hold.
  const after = readableCookies(staging, mockKey);
  const changed = migrated.reduce((s, t) => s + t.changed, 0);
  const readable = eachEncrypted(staging, (v) => (decrypt(mockKey, v) === null ? null : false), false)
    .reduce((s, t) => s + (t.found - t.undecryptable), 0);
  if (after !== before) throw new Refusal(`cookie count moved: ${before} readable before, ${after} after — the live profile is untouched`);
  if (readable < changed) throw new Refusal(`only ${readable} of ${changed} re-encrypted values read back — the live profile is untouched`);

  const backup = `${profile}.pre-mock-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  renameSync(profile, backup);
  renameSync(staging, profile);
  swapped = true;
  writeFileSync(join(profile, MARKER), "mock\n");
  unlinkSync(join(profile, LOCK));
  rmSync(join(backup, LOCK), { force: true });
  console.log(JSON.stringify({ profile, backup, cookiesReadableBefore: before, cookiesReadableAfter: after, reencrypted: changed, tables: migrated }, null, 1));
} catch (error) {
  if (!(error instanceof Refusal)) throw error;
  console.error(`migrate-keychain: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (!swapped) {
    rmSync(staging, { recursive: true, force: true });
    rmSync(join(profile, LOCK), { force: true });
  }
}
