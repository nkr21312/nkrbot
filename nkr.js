// =====================================================
// NO DOTENV — Render uses process.env directly
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
// ENV CHECK (HARD FAIL)
// =====================================================
if (!process.env.DISCORD_BOT_TOKEN) {
  throw new Error("DISCORD_BOT_TOKEN missing");
}
if (!process.env.GUILD_ID) {
  throw new Error("GUILD_ID missing");
}

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
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Channel]
});

// =====================================================
// KEEP-ALIVE SERVER (RENDER)
// =====================================================
const app = express();
app.get("/", (_, res) => res.send("NKR.bot alive"));
app.listen(process.env.PORT || 3000);

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

async function callAI(userId, text) {
  if (!OPENROUTER_API_KEY) return "AI is not configured.";

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
      max_tokens: 500
    })
  });

  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content || "No reply.";
  convo.push({ role: "assistant", content: reply });
  return reply;
}

// =====================================================
// MESSAGE FILTERING
// =====================================================
function shouldReply(msg) {
  if (msg.author.bot) return false;
  if (!msg.guild) return true; // DM
  if (msg.mentions.has(client.user)) return true;
  if (msg.content.toLowerCase().startsWith("!ask")) return true;
  return false;
}

function extractText(msg) {
  let t = msg.content.replace(`<@${client.user.id}>`, "").trim();
  if (t.toLowerCase().startsWith("!ask")) t = t.slice(4).trim();
  return t || "Hello!";
}

// =====================================================
// SLASH COMMANDS (GLOBAL + MOD)
// =====================================================
const globalCommands = [
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask the AI")
    .addStringOption(o =>
      o.setName("question").setDescription("Your question").setRequired(true)
    ),
  new SlashCommandBuilder().setName("help").setDescription("Help menu")
].map(c => c.toJSON());

const guildCommands = [
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member")
    .addUserOption(o =>
      o.setName("target").setDescription("Member").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member")
    .addUserOption(o =>
      o.setName("target").setDescription("Member").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("mute")
    .setDescription("Timeout a member (minutes)")
    .addUserOption(o =>
      o.setName("target").setDescription("Member").setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName("minutes").setDescription("Minutes").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a member")
    .addUserOption(o =>
      o.setName("target").setDescription("Member").setRequired(true)
    )
    .addStringOption(o =>
      o.setName("reason").setDescription("Reason").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("View warnings")
    .addUserOption(o =>
      o.setName("target").setDescription("Member").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Clear messages")
    .addIntegerOption(o =>
      o.setName("amount").setDescription("Count").setRequired(true)
    )
].map(c => c.toJSON());

// =====================================================
// REGISTER COMMANDS
// =====================================================
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: globalCommands });
  await rest.put(
    Routes.applicationGuildCommands(client.user.id, GUILD_ID),
    { body: guildCommands }
  );
  console.log("Commands registered");
}

// =====================================================
// READY + ACTIVITIES (LONG LIST)
// =====================================================
client.once("ready", async () => {
  console.log(`ONLINE as ${client.user.tag}`);
  await registerCommands();

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
// SLASH INTERACTIONS
// =====================================================
client.on("interactionCreate", async i => {
  if (!i.isChatInputCommand()) return;

  const cmd = i.commandName;

  if (cmd === "ask") {
    await i.deferReply();
    const q = i.options.getString("question");
    const r = await callAI(i.user.id, q);
    await i.editReply(r.slice(0, 2000));
  }

  if (cmd === "help") {
    await i.reply({
      content:
        "Use:\n/ask\n!ask\n@mention\nDM\nModeration enabled",
      ephemeral: true
    });
  }

  if (cmd === "kick") {
    if (!i.memberPermissions.has(PermissionFlagsBits.KickMembers))
      return i.reply({ content: "No permission", ephemeral: true });
    const u = i.options.getUser("target");
    await i.guild.members.kick(u.id);
    await i.reply(`Kicked ${u.tag}`);
  }

  if (cmd === "ban") {
    if (!i.memberPermissions.has(PermissionFlagsBits.BanMembers))
      return i.reply({ content: "No permission", ephemeral: true });
    const u = i.options.getUser("target");
    await i.guild.members.ban(u.id);
    await i.reply(`Banned ${u.tag}`);
  }

  if (cmd === "mute") {
    const u = i.options.getUser("target");
    const m = i.options.getInteger("minutes");
    const mem = await i.guild.members.fetch(u.id);
    await mem.timeout(m * 60 * 1000);
    await i.reply(`Muted ${u.tag}`);
  }

  if (cmd === "warn") {
    const u = i.options.getUser("target");
    const r = i.options.getString("reason") || "No reason";
    const warns = await loadWarnings();
    warns[i.guild.id] ??= {};
    warns[i.guild.id][u.id] ??= [];
    warns[i.guild.id][u.id].push({ reason: r });
    await saveWarnings(warns);
    await i.reply(`Warned ${u.tag}`);
  }

  if (cmd === "warnings") {
    const u = i.options.getUser("target") || i.user;
    const warns = await loadWarnings();
    const list = warns[i.guild.id]?.[u.id] || [];
    await i.reply({
      content: list.length
        ? list.map((w, x) => `${x + 1}. ${w.reason}`).join("\n")
        : "No warnings",
      ephemeral: true
    });
  }

  if (cmd === "clear") {
    const amt = i.options.getInteger("amount");
    await i.channel.bulkDelete(amt, true);
    await i.reply({ content: "Messages cleared", ephemeral: true });
  }
});

// =====================================================
// MESSAGE AI (!ask / mention / DM)
// =====================================================
client.on("messageCreate", async msg => {
  if (!shouldReply(msg)) return;
  try {
    const text = extractText(msg);
    const r = await callAI(msg.author.id, text);
    await msg.reply(r.slice(0, 2000));
  } catch {
    msg.reply("Error processing message.");
  }
});

// =====================================================
// START
// =====================================================
client.login(TOKEN);
