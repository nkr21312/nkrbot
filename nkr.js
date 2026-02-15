// =====================================================
// RENDER READY NKR.BOT
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
// ENV CHECK
// =====================================================

if (!process.env.DISCORD_BOT_TOKEN) throw new Error("DISCORD_BOT_TOKEN missing");
if (!process.env.GUILD_ID) throw new Error("GUILD_ID missing");

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || null;

// =====================================================
// DISCORD CLIENT
// =====================================================

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

// =====================================================
// KEEP ALIVE SERVER (RENDER)
// =====================================================

const app = express();
app.get("/", (_, res) => res.send("NKR.bot alive"));
app.listen(process.env.PORT || 3000);

// =====================================================
// WARN STORAGE
// =====================================================

const WARN_FILE = path.resolve("./warnings.json");

async function loadWarnings() {
  try { return JSON.parse(await fs.readFile(WARN_FILE, "utf8")); }
  catch { return {}; }
}

async function saveWarnings(data) {
  await fs.writeFile(WARN_FILE, JSON.stringify(data, null, 2));
}

// =====================================================
// AI MEMORY
// =====================================================

const memory = new Map();

async function callAI(userId, text) {
  if (!OPENROUTER_API_KEY) return "AI not configured.";

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
      messages: convo
    })
  });

  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content || "No reply.";
  convo.push({ role: "assistant", content: reply });
  return reply;
}

// =====================================================
// SLASH COMMANDS
// =====================================================

const globalCommands = [
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask the AI")
    .addStringOption(o =>
      o.setName("question")
       .setDescription("Your question")
       .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Help menu")
].map(c => c.toJSON());

const guildCommands = [

  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member")
    .addUserOption(o => o.setName("target").setDescription("Member").setRequired(true)),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member")
    .addUserOption(o => o.setName("target").setDescription("Member").setRequired(true)),

  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Unban a member")
    .addUserOption(o => o.setName("target").setDescription("Member").setRequired(true)),

  new SlashCommandBuilder()
    .setName("mute")
    .setDescription("Timeout a member")
    .addUserOption(o => o.setName("target").setDescription("Member").setRequired(true))
    .addIntegerOption(o => o.setName("minutes").setDescription("Minutes").setRequired(true)),

  new SlashCommandBuilder()
    .setName("unmute")
    .setDescription("Remove timeout")
    .addUserOption(o => o.setName("target").setDescription("Member").setRequired(true)),

  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn member")
    .addUserOption(o => o.setName("target").setDescription("Member").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason")),

  new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("View warnings")
    .addUserOption(o => o.setName("target").setDescription("Member")),

  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Clear messages")
    .addIntegerOption(o => o.setName("amount").setDescription("Count").setRequired(true))

].map(c => c.toJSON());

// =====================================================
// REGISTER COMMANDS
// =====================================================

async function registerSlashCommands() {

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  try {

    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: globalCommands }
    );

    await rest.put(
      Routes.applicationGuildCommands(client.user.id, GUILD_ID),
      { body: guildCommands }
    );

    console.log("✅ Commands registered correctly.");

  } catch (err) {
    console.error("❌ Command registration failed:", err);
  }
}

// =====================================================
// READY EVENT + ACTIVITIES
// =====================================================

client.once("ready", async () => {

  console.log(`ONLINE as ${client.user.tag}`);

  await registerSlashCommands();

  const activities = [
    "🧠 AI Chat",
    "/ask for help",
    "!ask quick questions",
    "📩 DM me anything",
    "👀 Watching chats",
    "🛠️ Moderation ready",
    "⚡ Fast AI replies",
    "🤖 Smart assistant",
    "📜 /help for commands",
    "✨ Mention me",
    "🔄 Always active",
    "🌐 Running on Render",
    "💡 Solving doubts",
    "🧩 Server helper",
    "📊 Managing chats",
    "🧠 Learning users"
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

client.on("interactionCreate", async i => {

  if (!i.isChatInputCommand()) return;

  const cmd = i.commandName;

  if (cmd === "ask") {
    await i.deferReply();
    const r = await callAI(i.user.id, i.options.getString("question"));
    return i.editReply(r.slice(0, 2000));
  }

  if (cmd === "help")
    return i.reply({ content: "Use /ask or moderation commands.", ephemeral: true });

  if (cmd === "kick") {
    if (!i.memberPermissions.has(PermissionFlagsBits.KickMembers))
      return i.reply({ content: "No permission", ephemeral: true });
    const u = i.options.getUser("target");
    await i.guild.members.kick(u.id);
    return i.reply(`Kicked ${u.tag}`);
  }

  if (cmd === "ban") {
    if (!i.memberPermissions.has(PermissionFlagsBits.BanMembers))
      return i.reply({ content: "No permission", ephemeral: true });
    const u = i.options.getUser("target");
    await i.guild.members.ban(u.id);
    return i.reply(`Banned ${u.tag}`);
  }

  if (cmd === "unban") {
    const u = i.options.getUser("target");
    await i.guild.members.unban(u.id);
    return i.reply(`Unbanned ${u.tag}`);
  }

  if (cmd === "mute") {
    const u = i.options.getUser("target");
    const minutes = i.options.getInteger("minutes");
    const member = await i.guild.members.fetch(u.id);
    await member.timeout(minutes * 60000);
    return i.reply(`Muted ${u.tag}`);
  }

  if (cmd === "unmute") {
    const u = i.options.getUser("target");
    const member = await i.guild.members.fetch(u.id);
    await member.timeout(null);
    return i.reply(`Unmuted ${u.tag}`);
  }

  if (cmd === "warn") {
    const u = i.options.getUser("target");
    const reason = i.options.getString("reason") || "No reason";
    const warns = await loadWarnings();

    if (!warns[i.guild.id]) warns[i.guild.id] = {};
    if (!warns[i.guild.id][u.id]) warns[i.guild.id][u.id] = [];

    warns[i.guild.id][u.id].push({ reason });
    await saveWarnings(warns);

    return i.reply(`Warned ${u.tag}`);
  }

  if (cmd === "warnings") {
    const u = i.options.getUser("target") || i.user;
    const warns = await loadWarnings();
    const list = warns[i.guild.id]?.[u.id] || [];
    return i.reply({
      content: list.length ? JSON.stringify(list) : "No warnings",
      ephemeral: true
    });
  }

  if (cmd === "clear") {
    const amt = i.options.getInteger("amount");
    await i.channel.bulkDelete(amt, true);
    return i.reply({ content: "Messages cleared", ephemeral: true });
  }
});

// =====================================================
// START BOT
// =====================================================

console.log("Starting Discord login...");
client.login(TOKEN)
  .then(() => console.log("LOGIN SUCCESS"))
  .catch(err => console.error("LOGIN FAILED:", err));


