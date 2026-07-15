// Flow Debug key-license server
//
// Endpoints (bot-only ones require header "x-bot-secret" matching BOT_SECRET env var):
//   POST /keys/generate   { nickname, duration, discordUserId } -> { key, nickname, expiresAt }
//   POST /keys/terminate  { nickname }                         -> { revokedCount }
//   POST /auth            { key, deviceId }  (called by the mod, no secret needed)
//
// Storage is a single JSON file (keys.json) next to this script - no database needed.

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json());

const DB_PATH = path.join(__dirname, "keys.json");
const BOT_SECRET = process.env.BOT_SECRET;
const PORT = process.env.PORT || 3000;

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
    const MS_MONTH = 30 * MS_DAY; // approximate, good enough for a license window

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

// --- Terminate all keys matching a nickname (bot only) ---
app.post("/keys/terminate", requireBotSecret, (req, res) => {
    const { nickname } = req.body || {};

    if (!nickname || typeof nickname !== "string") {
        return res.status(400).json({ error: "nickname is required" });
    }

    const keys = readKeys();
    let revokedCount = 0;

    for (const key of Object.keys(keys)) {
        if (keys[key].nickname === nickname && !keys[key].revoked) {
            keys[key].revoked = true;
            revokedCount++;
        }
    }

    writeKeys(keys);
    res.json({ revokedCount });
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

    if (!entry.boundDeviceId) {
        entry.boundDeviceId = deviceId;
    } else if (entry.boundDeviceId !== deviceId) {
        return res.json({ valid: false, reason: "device_mismatch" });
    }

    entry.lastSeenAt = Date.now();
    writeKeys(keys);

    res.json({ valid: true });
});

app.get("/", (req, res) => res.send("Flow Debug key server is running."));

app.listen(PORT, () => console.log(`Key server listening on port ${PORT}`));
