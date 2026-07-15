// Flow Debug key-generation Discord bot
//
// Slash commands:
//   /flowkey generate @user plan:<Lifetime|Monthly>
//   /flowkey terminate @user reason:<text>
//
// Requires Node 18+ (built-in fetch). Run "npm install" then "npm start".
//
// Environment variables:
//   DISCORD_TOKEN     - your bot's token
//   DISCORD_CLIENT_ID - your bot's application ID
//   DISCORD_GUILD_ID  - (optional) guild ID for instant command registration
//   KEY_SERVER_URL    - public URL of your key server
//   BOT_SECRET        - must match the BOT_SECRET set on the key server
//   ALLOWED_ROLE_ID   - (optional) Discord role ID required to use /flowkey

const {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    REST,
    Routes,
    MessageFlags,
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const API_URL = process.env.KEY_SERVER_URL;
const BOT_SECRET = process.env.BOT_SECRET;
const ALLOWED_ROLE_ID = process.env.ALLOWED_ROLE_ID;

if (!TOKEN || !CLIENT_ID || !API_URL || !BOT_SECRET) {
    console.error("Missing required environment variables. Need DISCORD_TOKEN, DISCORD_CLIENT_ID, KEY_SERVER_URL, BOT_SECRET.");
    process.exit(1);
}

// In-memory cache: discordUserId -> { key, plan, generatedAt }
// Persists only while bot is running. If you restart, cache clears.
const keyCache = new Map();

// Helper: fetch with timeout so we never hang forever
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        return res;
    } finally {
        clearTimeout(id);
    }
}

// Helper: DM a user, handle closed DMs gracefully
async function dmUser(user, content) {
    try {
        return await user.send(content);
    } catch (err) {
        if (err.code === 50007) {
            console.log(`Cannot DM ${user.tag} (${user.id}): DMs closed`);
            return null;
        }
        throw err;
    }
}

const flowkeyCommand = new SlashCommandBuilder()
    .setName("flowkey")
    .setDescription("Manage Flow Debug license keys")
    .addSubcommand((sub) =>
        sub
            .setName("generate")
            .setDescription("Generate a license key for a user")
            .addUserOption((opt) =>
                opt
                    .setName("user")
                    .setDescription("The user to generate a key for")
                    .setRequired(true)
            )
            .addStringOption((opt) =>
                opt
                    .setName("plan")
                    .setDescription("Key plan type")
                    .setRequired(true)
                    .addChoices(
                        { name: "Lifetime", value: "forever" },
                        { name: "Monthly", value: "1month" }
                    )
            )
    )
    .addSubcommand((sub) =>
        sub
            .setName("terminate")
            .setDescription("Terminate a user's license key")
            .addUserOption((opt) =>
                opt
                    .setName("user")
                    .setDescription("The user whose key to terminate")
                    .setRequired(true)
            )
            .addStringOption((opt) =>
                opt
                    .setName("reason")
                    .setDescription("Reason for termination")
                    .setRequired(true)
            )
    );

async function registerCommands() {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    const body = [flowkeyCommand.toJSON()];

    if (GUILD_ID) {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
        console.log("Registered /flowkey as a guild command (instant).");
    } else {
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
        console.log("Registered /flowkey as a global command (can take up to an hour to show up).");
    }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "flowkey") return;

    if (!interaction.inGuild()) {
        return interaction.reply({ content: "This command only works in servers.", flags: MessageFlags.Ephemeral });
    }

    if (ALLOWED_ROLE_ID && !interaction.member?.roles?.cache?.has(ALLOWED_ROLE_ID)) {
        return interaction.reply({ content: "You don't have permission to use this.", flags: MessageFlags.Ephemeral });
    }

    const sub = interaction.options.getSubcommand();

    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (deferErr) {
        console.error("Failed to defer reply:", deferErr);
        return;
    }

    try {
        if (sub === "generate") {
            const targetUser = interaction.options.getUser("user", true);
            const plan = interaction.options.getString("plan", true);
            const duration = plan; // "forever" or "1month"

            const res = await fetchWithTimeout(`${API_URL}/keys/generate`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-bot-secret": BOT_SECRET },
                body: JSON.stringify({
                    discordUserId: targetUser.id,
                    nickname: targetUser.username,
                    duration,
                }),
            });

            const data = await res.json();

            if (!res.ok) {
                return interaction.editReply(`Failed to generate key: ${data.error || "server error"}`);
            }

            // Cache the key so terminate can show it struck-through later
            keyCache.set(targetUser.id, {
                key: data.key,
                plan,
                generatedAt: Date.now(),
            });

            // DM the target user
            const dmContent =
                `:closed_lock_with_key: **Flow Addon License Key**\n\n` +
                `**Your personal key:**\n\`\`\`\n${data.key}\n\`\`\`\n` +
                `**To activate in-game:**\n\`\`\`\nGoto the Flow Key module and input the key\n\`\`\`\n` +
                `> :warning: Do not share this key. It is tied to your HWID and can be revoked at any time.`;

            const dmSent = await dmUser(targetUser, dmContent);

            const expiryText = data.expiresAt
                ? `<t:${Math.floor(data.expiresAt / 1000)}:F>`
                : "Never (permanent)";

            return interaction.editReply(
                `✅ **Key generated for ${targetUser}**\n` +
                `Plan: \`${plan}\`\n` +
                `Key: \`${data.key}\`\n` +
                `Expires: ${expiryText}\n` +
                `DM sent: ${dmSent ? "✅" : "❌ (user has DMs closed)"}`
            );
        }

        if (sub === "terminate") {
            const targetUser = interaction.options.getUser("user", true);
            const reason = interaction.options.getString("reason", true);
            const cached = keyCache.get(targetUser.id);

            const res = await fetchWithTimeout(`${API_URL}/keys/terminate`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-bot-secret": BOT_SECRET },
                body: JSON.stringify({
                    discordUserId: targetUser.id,
                    nickname: targetUser.username,
                }),
            });

            const data = await res.json();

            if (!res.ok) {
                return interaction.editReply(`Failed to terminate: ${data.error || "server error"}`);
            }

            // Build DM content with struck-through key if cached
            let dmContent = `:closed_lock_with_key: **Flow Addon License Key**\n\n**Your Personal key has been terminated**\n`;
            if (cached) {
                dmContent += `\`\`\`\n~~${cached.key}~~\n\`\`\`\n`;
            } else {
                dmContent += `\`\`\`\nKey no longer available\n\`\`\`\n`;
            }
            dmContent += `**Reason**\n\`\`\`\n${reason}\n\`\`\`\n`;
            dmContent += `> :warning: If you think this is wrong please open a support ticket in our discord`;

            const dmSent = await dmUser(targetUser, dmContent);

            // Purge from cache
            keyCache.delete(targetUser.id);

            return interaction.editReply(
                `🔒 **Terminated ${data.revokedCount || 0} key(s) for ${targetUser}**\n` +
                `Reason: \`${reason}\`\n` +
                `DM sent: ${dmSent ? "✅" : "❌ (user has DMs closed)"}`
            );
        }
    } catch (e) {
        console.error("Command error:", e);
        const msg = `Something went wrong: ${e.message || "request timed out or server unreachable"}`;
        try {
            await interaction.editReply(msg);
        } catch (editErr) {
            console.error("Failed to edit reply:", editErr);
        }
    }
});

client.once("ready", () => console.log(`Logged in as ${client.user.tag}`));

registerCommands()
    .then(() => client.login(TOKEN))
    .catch((e) => {
        console.error("Failed to register commands:", e);
        process.exit(1);
    });
