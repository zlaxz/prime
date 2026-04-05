const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const sqlite3 = require("better-sqlite3");
const { execSync } = require("child_process");

const home = require("os").homedir();
const cookiePath = path.join(home, "Library/Application Support/Claude/Cookies");
const cookieDb = new sqlite3(cookiePath, {readonly: true});
const row = cookieDb.prepare("SELECT encrypted_value FROM cookies WHERE host_key = ? AND name = ?").get(".claude.ai", "sessionKey");
cookieDb.close();

if (!row) { console.log("No sessionKey cookie found"); process.exit(1); }

const encKey = execSync("security find-generic-password -s \"Claude Safe Storage\" -a \"Claude Key\" -w").toString().trim();
const key = crypto.pbkdf2Sync(encKey, "saltysalt", 1003, 16, "sha1");
const iv = Buffer.alloc(16, " ");
const enc = row.encrypted_value.slice(3);
const d = crypto.createDecipheriv("aes-128-cbc", key, iv);
let r = d.update(enc);
r = Buffer.concat([r, d.final()]);
const sessionKey = r.toString("utf8");

fs.writeFileSync(path.join(home, ".claude/session-key.txt"), sessionKey);
console.log("SAVED:", sessionKey.slice(0, 40) + "...");
