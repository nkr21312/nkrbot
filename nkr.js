// ================= ENV =================
import dotenv from "dotenv";
dotenv.config(); // Render injects env automatically

// ================= IMPORTS =================
import {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionFlagsBits
} from "discord.js";
import fetch from "node-fetch";
import express from "express";
import fs from "fs/promises";
import path from "path";

// ================= CONFIG =================
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!DISCORD_BOT_TOKEN) {
  console.error("❌ Missing DISCORD_BOT_TOKEN");
  process.exit(1);
}

// ================= CLIENT =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

// ================= KEEP ALIVE =================
const app = express();
app.get("/", (_, res) => res.send("NKR.bot alive"));
app.listen(process.env.PORT || 3000);

// ================= WARN STORAGE =================
const WARN_FILE = path.resolve("./warnings.json");

async function loadWarnings() {
  try {
    return JSON.parse(await fs.readFile(WARN_FILE, "utf8"));
  } catch {
    return {};
  }
}
async function saveWarnings(data) {
  await fs.writeFile(WARN_FILE, JSON.stringify(data, null, 2));
}

// ================= AI MEMORY =================
const memory = new Map();

// ================= HELPERS =================
async function sendLog(text) {
  if (!LOG_CHANNEL_ID) return;
  try {
    const ch = await client.channels.fetch(LOG_CHANNEL_ID);
    if (ch?.isTextBased()) await ch.send(text);
  } catch {}
}

async function callOpenRouter(userId, text) {
  if (!OPENROUTER_API_KEY) return "AI key missing.";

  if (!memory.has(userId)) memory.set(userId, []);
  const convo = memory.get(userId);
  convo.push({ role: "user", content: text });
  if (convo.length > 10) convo.shift();

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      messages: convo,
      max_tokens: 400
    })
  });

  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content || "No reply.";
  convo.push({ role: "assistant", content: reply });
  return reply;
}

// ================= COMMANDS =================
const globalCommands = [
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask the AI")
    .addStringOption(o =>
      o.setName("question").setDescription("Your question").setRequired(true)
    ),
  new SlashCommandBuilder().setName("help").setDescription("Show help"),
  new SlashCommandBuilder().setName("donate").setDescription("Support the bot")
].map(c => c.toJSON());

const guildCommands = [
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member")
    .addUserOption(o => o.setName("target").setRequired(true)),
  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member")
    .addUserOption(o => o.setName("target").setRequired(true)),
  new SlashCommandBuilder()
    .setName("mute")
    .setDescription("Timeout a member (minutes)")
    .addUserOption(o => o.setName("target").setRequired(true))
    .addIntegerOption(o => o.setName("minutes").setRequired(true)),
  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a member")
    .addUserOption(o => o.setName("target").setRequired(true))
    .addStringOption(o => o.setName("reason"))
].map(c => c.toJSON());

// ================= REGISTER COMMANDS =================
async function registerSlashCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);

  await rest.put(
    Routes.applicationCommands(client.user.id),
    { body: globalCommands }
  );

  await rest.put(
    Routes.applicationGuildCommands(client.user.id, GUILD_ID),
    { body: guildCommands }
  );

  console.log("✅ Slash commands registered");
}

// ================= READY =================
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerSlashCommands();
  await sendLog(`✅ Bot online: ${client.user.tag}`);
});

// ================= INTERACTIONS =================
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    const { commandName } = interaction;

    if (commandName === "ask") {
      const q = interaction.options.getString("question");
      await interaction.deferReply();
      const r = await callOpenRouter(interaction.user.id, q);
      await interaction.editReply(r.slice(0, 2000));
    }

    if (commandName === "help") {
      await interaction.reply({ content: "/ask /donate + moderation", ephemeral: true });
    }

    if (commandName === "donate") {
      await interaction.reply({ content: "❤️ Support link here", ephemeral: true });
    }

    if (commandName === "kick") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.KickMembers))
        return interaction.reply({ content: "No permission", ephemeral: true });

      const user = interaction.options.getUser("target");
      const m = await interaction.guild.members.fetch(user.id);
      await m.kick();
      await interaction.reply(`✅ Kicked ${user.tag}`);
    }

    if (commandName === "ban") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.BanMembers))
        return interaction.reply({ content: "No permission", ephemeral: true });

      const user = interaction.options.getUser("target");
      await interaction.guild.members.ban(user.id);
      await interaction.reply(`✅ Banned ${user.tag}`);
    }

    if (commandName === "mute") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.ModerateMembers))
        return interaction.reply({ content: "No permission", ephemeral: true });

      const user = interaction.options.getUser("target");
      const min = interaction.options.getInteger("minutes");
      const m = await interaction.guild.members.fetch(user.id);
      await m.timeout(min * 60 * 1000);
      await interaction.reply(`🔇 Muted ${user.tag}`);
    }

    if (commandName === "warn") {
      const user = interaction.options.getUser("target");
      const reason = interaction.options.getString("reason") || "No reason";

      const warns = await loadWarnings();
      warns[interaction.guild.id] ??= {};
      warns[interaction.guild.id][user.id] ??= [];
      warns[interaction.guild.id][user.id].push({ reason, by: interaction.user.tag });

      await saveWarnings(warns);
      await interaction.reply(`⚠️ Warned ${user.tag}`);
    }

  } catch (err) {
    console.error(err);
    if (!interaction.replied)
      interaction.reply({ content: "⚠️ Error", ephemeral: true });
  }
});

// ================= START =================
client.login(DISCORD_BOT_TOKEN);
