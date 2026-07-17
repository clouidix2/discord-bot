// Flow Debug key-license server
//
// Endpoints (bot-only ones require header "x-bot-secret" matching BOT_SECRET env var):
//   POST /keys/generate      { nickname, duration, discordUserId } -> { key, nickname, expiresAt }
//   POST /keys/terminate     { nickname, discordUserId }           -> { revokedCount, revokedKeys }
//   POST /keys/revoke-by-key { key }                               -> { revoked: boolean }
//   GET  /keys/status/:discordUserId                               -> { hasValidKey, plan, expiresAt, key }
//   GET  /keys/list                                                -> full key dump (for the bot's expiry sweep)
//   POST /auth                { key, deviceId }  (called by the mod, no secret needed)
//
// Storage is a single JSON file (keys.json) stored at /data (Railway volume mount path),
// so it survives redeploys and restarts.

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json());

function resolveDataDir() {
    const candidates = [process.env.RAILWAY_VOLUME_MOUNT_PATH, "/data"].filter(Boolean);
    for (const dir of candidates) {
        try {
            if (fs.existsSync(dir)) return dir;
        } catch (e) {
            // ignore and try next candidate
        }
    }
    console.warn("WARNING: Could not find /data or RAILWAY_VOLUME_MOUNT_PATH - falling back to local folder. keys.json will NOT persist across redeploys.");
    return __dirname;
}

const DATA_DIR = resolveDataDir();
const DB_PATH = path.join(DATA_DIR, "keys.json");
const BOT_SECRET = process.env.BOT_SECRET;
const PORT = process.env.PORT || 3000;

console.log(`Storing keys.json at: ${DB_PATH}`);

if (!BOT_SECRET) {
    console.error("BOT_SECRET environment variable is not set. Refusing to start.");
    process.exit(1);
}

function readKeys() {
    if (!fs.existsSync(DB_PATH)) return {};
    try {
        return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    } catch (e) {
        console.error("Failed to read keys.json, starting fresh:", e);
        return {};
    }
}

function writeKeys(data) {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function generateKeyString() {
    const part = () => crypto.randomBytes(2).toString("hex").toUpperCase();
    return `FLOW-${part()}-${part()}-${part()}`;
}

// Returns milliseconds, or null for "forever" (no expiry). Throws on unparseable input.
function parseDuration(str) {
    if (!str) throw new Error("duration is required");
    const s = str.trim().toLowerCase();

    if (s === "forever" || s === "permanent" || s === "lifetime" || s === "never") return null;

    const match = s.match(/^(\d+)\s*(hour|hours|hr|hrs|day|days|week|weeks|month|months)$/);
    if (!match) {
        throw new Error(`Could not parse duration "${str}". Use formats like "1day", "2weeks", "1month", "5hours", or "forever".`);
    }

    const amount = parseInt(match[1], 10);
    const unit = match[2];

    const MS_HOUR = 60 * 60 * 1000;
    const MS_DAY = 24 * MS_HOUR;
    const MS_WEEK = 7 * MS_DAY;
    const MS_MONTH = 30 * MS_DAY;

    if (unit.startsWith("hour") || unit.startsWith("hr")) return amount * MS_HOUR;
    if (unit.startsWith("day")) return amount * MS_DAY;
    if (unit.startsWith("week")) return amount * MS_WEEK;
    if (unit.startsWith("month")) return amount * MS_MONTH;

    throw new Error(`Unrecognized duration unit in "${str}"`);
}

function requireBotSecret(req, res, next) {
    if (req.get("x-bot-secret") !== BOT_SECRET) {
        return res.status(401).json({ error: "unauthorized" });
    }
    next();
}

// A key counts as "monthly" if it has an expiry, "lifetime" if it doesn't.
// (Our system only ever issues "forever" or "1month" via the bot's UI, so this
// simple rule is enough to tell the two apart without a separate stored field.)
function planOf(entry) {
    return entry.expiresAt === null ? "lifetime" : "monthly";
}

function isCurrentlyValid(entry) {
    if (entry.revoked) return false;
    if (entry.expiresAt && Date.now() > entry.expiresAt) return false;
    return true;
}

// --- Generate a new key (bot only) ---
app.post("/keys/generate", requireBotSecret, (req, res) => {
    const { nickname, duration, discordUserId } = req.body || {};

    if (!nickname || typeof nickname !== "string") {
        return res.status(400).json({ error: "nickname is required" });
    }

    let durationMs;
    try {
        durationMs = parseDuration(duration);
    } catch (e) {
        return res.status(400).json({ error: e.message });
    }

    const keys = readKeys();
    let key;
    do {
        key = generateKeyString();
    } while (keys[key]);

    const now = Date.now();
    keys[key] = {
        nickname,
        createdAt: now,
        createdFor: discordUserId || null,
        expiresAt: durationMs === null ? null : now + durationMs,
        revoked: false,
        boundDeviceId: null,
        lastSeenAt: null,
    };

    writeKeys(keys);
    res.json({ key, nickname, expiresAt: keys[key].expiresAt });
});

// --- Terminate keys by discordUserId (preferred) or nickname (fallback) ---
app.post("/keys/terminate", requireBotSecret, (req, res) => {
    const { nickname, discordUserId } = req.body || {};

    if (!nickname && !discordUserId) {
        return res.status(400).json({ error: "nickname or discordUserId is required" });
    }

    const keys = readKeys();
    let revokedCount = 0;
    const revokedKeys = [];

    for (const key of Object.keys(keys)) {
        let match = false;

        if (discordUserId && keys[key].createdFor === discordUserId) {
            match = true;
        } else if (nickname && keys[key].nickname === nickname) {
            match = true;
        }

        if (match && !keys[key].revoked) {
            keys[key].revoked = true;
            revokedCount++;
            revokedKeys.push(key);
        }
    }

    writeKeys(keys);
    res.json({ revokedCount, revokedKeys });
});

// --- Revoke one specific key by its literal string (bot only) ---
// Used for the upgrade flow (revoking the old monthly key specifically) and
// the 7-day-unused sweep, where we need to revoke exactly one key rather
// than "everything under this user".
app.post("/keys/revoke-by-key", requireBotSecret, (req, res) => {
    const { key } = req.body || {};

    if (!key) return res.status(400).json({ error: "key is required" });

    const keys = readKeys();
    const entry = keys[key];

    if (!entry) return res.status(404).json({ error: "not_found" });

    const wasAlreadyRevoked = entry.revoked;
    entry.revoked = true;
    writeKeys(keys);

    res.json({ revoked: !wasAlreadyRevoked });
});

// --- Look up a user's current best key status (bot only) ---
// Prefers a lifetime key over a monthly one if a user somehow has both.
app.get("/keys/status/:discordUserId", requireBotSecret, (req, res) => {
    const { discordUserId } = req.params;
    const keys = readKeys();

    let best = null;
    let bestKeyString = null;

    for (const key of Object.keys(keys)) {
        const entry = keys[key];
        if (entry.createdFor !== discordUserId) continue;
        if (!isCurrentlyValid(entry)) continue;

        if (!best || (planOf(entry) === "lifetime" && planOf(best) !== "lifetime")) {
            best = entry;
            bestKeyString = key;
        }
    }

    if (!best) {
        return res.json({ hasValidKey: false, plan: null, expiresAt: null, key: null });
    }

    res.json({
        hasValidKey: true,
        plan: planOf(best),
        expiresAt: best.expiresAt,
        key: bestKeyString,
    });
});

// --- Full key dump, for the bot's periodic 7-day-unused sweep (bot only) ---
app.get("/keys/list", requireBotSecret, (req, res) => {
    const keys = readKeys();
    const list = Object.keys(keys).map((key) => ({ key, ...keys[key] }));
    res.json({ keys: list });
});

// --- Validate a key (called by the mod) ---
app.post("/auth", (req, res) => {
    const { key, deviceId } = req.body || {};

    if (!key || !deviceId) {
        return res.status(400).json({ valid: false, reason: "missing_fields" });
    }

    const keys = readKeys();
    const entry = keys[key];

    if (!entry) return res.json({ valid: false, reason: "invalid_key" });
    if (entry.revoked) return res.json({ valid: false, reason: "revoked" });
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
        return res.json({ valid: false, reason: "expired" });
    }

    // Device-level lock: if this device is already bound to a DIFFERENT key,
    // refuse - even if the key being tried right now is itself unused/valid.
    // This is on top of the existing key-level lock below (a key can only
    // ever bind to the first device that uses it).
    for (const otherKeyString of Object.keys(keys)) {
        if (otherKeyString === key) continue;
        if (keys[otherKeyString].boundDeviceId === deviceId) {
            return res.json({ valid: false, reason: "device_already_registered_to_another_key" });
        }
    }

    if (!entry.boundDeviceId) {
        entry.boundDeviceId = deviceId;
    } else if (entry.boundDeviceId !== deviceId) {
        return res.json({ valid: false, reason: "device_mismatch" });
    }

    entry.lastSeenAt = Date.now();
    writeKeys(keys);

    res.json({ valid: true });
});

app.get("/", (req, res) => res.send(`Flow Debug key server is running. Storing keys at: ${DB_PATH}`));

app.listen(PORT, () => console.log(`Key server listening on port ${PORT}`));
