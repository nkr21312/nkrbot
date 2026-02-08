// =====================================================
// ENV (Render-safe)
// =====================================================
import dotenv from "dotenv";
dotenv.config(); // Render injects env automatically

// =====================================================
// IMPORTS
// =====================================================
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

// =====================================================
// CONFIG
// =====================================================
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!DISCORD_BOT_TOKEN) {
  console.error("❌ DISCORD_BOT_TOKEN missing");
  process.exit(1);
}

// =====================================================
// DISCORD CLIENT
// =====================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Channel]
});

// =====================================================
// KEEP ALIVE (RENDER)
// =====================================================
const app = express();
app.get("/", (_, res) => res.send("🧠 NKR.bot alive"));
app.listen(process.env.PORT || 3000, () =>
  console.log("🌐 Keep-alive server running")
);

// =====================================================
// WARNINGS STORAGE
// =====================================================
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

// =====================================================
// AI MEMORY + CALL
// =====================================================
const memory = new Map();

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
      messages: [
        { role: "system", content: "You are a friendly Discord assistant." },
        ...convo
      ],
      max_tokens: 500
    })
  });

  const data = await res.json();
  const reply =
    data?.choices?.[0]?.message?.content || "No response.";
  convo.push({ role: "assistant", content: reply });
  return reply;
}

// =====================================================
// LOG CHANNEL HELPER
// =====================================================
async function sendLog(text) {
  if (!LOG_CHANNEL_ID) return;
  try {
    const ch = await client.channels.fetch(LOG_CHANNEL_ID);
    if (ch?.isTextBased()) await ch.send(text);
  } catch {}
}

// =====================================================
// MESSAGE FILTERING
// =====================================================
function shouldReply(message) {
  if (message.author.bot) return false;
  if (message.channel?.type === 1) return true;
  if (message.mentions.has(client.user)) return true;
  if (message.content.startsWith("!")) return true;
  return false;
}
function extractText(message) {
  let t = message.content.replace(`<@${client.user.id}>`, "").trim();
  if (t.startsWith("!")) t = t.slice(1).trim();
  return t || "Hello!";
}

// =====================================================
// SLASH COMMANDS (FULL, PROPERLY SPLIT)
// =====================================================

// 🌍 GLOBAL COMMANDS
const globalCommands = [
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask the AI")
    .addStringOption(o =>
      o.setName("question").setRequired(true)
    ),
  new SlashCommandBuilder().setName("help").setDescription("Help menu"),
  new SlashCommandBuilder().setName("donate").setDescription("Support the bot")
].map(c => c.toJSON());

// 🏠 GUILD COMMANDS (MOD)
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
    .setDescription("Timeout a member")
    .addUserOption(o => o.setName("target").setRequired(true))
    .addIntegerOption(o => o.setName("minutes").setRequired(true)),
  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a member")
    .addUserOption(o => o.setName("target").setRequired(true))
    .addStringOption(o => o.setName("reason")),
  new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("View warnings")
    .addUserOption(o => o.setName("target")),
  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Clear messages")
    .addIntegerOption(o => o.setName("amount").setRequired(true))
].map(c => c.toJSON());

// =====================================================
// REGISTER COMMANDS (NO CRASH)
// =====================================================
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

// =====================================================
// READY
// =====================================================
client.once("ready", async () => {
  console.log(`🟢 ONLINE as ${client.user.tag}`);
  await registerSlashCommands();
  await sendLog(`🟢 Bot online: ${client.user.tag}`);

  const activities = [
    "🧠 AI Chat",
    "/ask for help",
    "Moderation ready",
    "DM me questions"
  ];
  let i = 0;
  setInterval(() => {
    client.user.setPresence({
      status: "online",
      activities: [{ name: activities[i], type: 0 }]
    });
    i = (i + 1) % activities.length;
  }, 15000);
});

// =====================================================
// INTERACTIONS
// =====================================================
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    const cmd = interaction.commandName;

    if (cmd === "ask") {
      await interaction.deferReply();
      const q = interaction.options.getString("question");
      const r = await callOpenRouter(interaction.user.id, q);
      await interaction.editReply(r.slice(0, 2000));
    }

    if (cmd === "help") {
      await interaction.reply({
        content: "/ask /donate + moderation",
        ephemeral: true
      });
    }

    if (cmd === "kick") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.KickMembers))
        return interaction.reply({ content: "No permission", ephemeral: true });
      const u = interaction.options.getUser("target");
      await interaction.guild.members.kick(u.id);
      await interaction.reply(`✅ Kicked ${u.tag}`);
    }

    if (cmd === "ban") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.BanMembers))
        return interaction.reply({ content: "No permission", ephemeral: true });
      const u = interaction.options.getUser("target");
      await interaction.guild.members.ban(u.id);
      await interaction.reply(`✅ Banned ${u.tag}`);
    }

    if (cmd === "mute") {
      const u = interaction.options.getUser("target");
      const min = interaction.options.getInteger("minutes");
      const m = await interaction.guild.members.fetch(u.id);
      await m.timeout(min * 60 * 1000);
      await interaction.reply(`🔇 Muted ${u.tag}`);
    }

    if (cmd === "warn") {
      const u = interaction.options.getUser("target");
      const r = interaction.options.getString("reason") || "No reason";
      const warns = await loadWarnings();
      warns[interaction.guild.id] ??= {};
      warns[interaction.guild.id][u.id] ??= [];
      warns[interaction.guild.id][u.id].push({ r, by: interaction.user.tag });
      await saveWarnings(warns);
      await interaction.reply(`⚠️ Warned ${u.tag}`);
    }

    if (cmd === "warnings") {
      const u = interaction.options.getUser("target") || interaction.user;
      const warns = await loadWarnings();
      const list = warns[interaction.guild.id]?.[u.id] || [];
      await interaction.reply({
        content: list.length
          ? list.map((w, i) => `${i + 1}. ${w.r}`).join("\n")
          : "No warnings",
        ephemeral: true
      });
    }

    if (cmd === "clear") {
      const amt = interaction.options.getInteger("amount");
      await interaction.channel.bulkDelete(amt, true);
      await interaction.reply({ content: "🧹 Cleared", ephemeral: true });
    }

  } catch (err) {
    console.error(err);
    if (!interaction.replied)
      interaction.reply({ content: "⚠️ Error", ephemeral: true });
  }
});

// =====================================================
// MESSAGE AI
// =====================================================
client.on("messageCreate", async msg => {
  if (!shouldReply(msg)) return;
  try {
    const text = extractText(msg);
    const r = await callOpenRouter(msg.author.id, text);
    await msg.reply(r.slice(0, 2000));
  } catch {}
});

// =====================================================
// START
// =====================================================
client.login(DISCORD_BOT_TOKEN);
