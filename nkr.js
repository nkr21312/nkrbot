// bot.js
// === Load environment variables ===
import dotenv from "dotenv";
dotenv.config({ path: "./tokens.env" });

// === Imports ===
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

// === Config / tokens ===
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID; // optional, set in Render

if (!DISCORD_BOT_TOKEN) {
  console.error("Missing DISCORD_BOT_TOKEN in environment. Exiting.");
  process.exit(1);
}

// === Discord client ===
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

// === Keep-alive web server (Render) ===
const app = express();
app.get("/", (req, res) => res.send("🧠 NKR.bot is alive!"));
app.listen(process.env.PORT || 3000, () =>
  console.log("🌐 Keep-alive web server running")
);

// === Warnings persistence (simple JSON file) ===
const WARN_FILE = path.resolve("./warnings.json");
async function loadWarnings() {
  try {
    const raw = await fs.readFile(WARN_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {}; // { guildId: { userId: [ { moderator, reason, time } ] } }
  }
}
async function saveWarnings(obj) {
  await fs.writeFile(WARN_FILE, JSON.stringify(obj, null, 2), "utf8");
}

// === In-memory conversation memory (AI) ===
const memory = new Map();

// === Helper: send log to fixed channel (if available) ===
async function sendLog(client, content) {
  try {
    if (!LOG_CHANNEL_ID) return;
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (channel && channel.isTextBased()) {
      await channel.send(content);
    }
  } catch (err) {
    console.error("Failed to send log:", err);
  }
}

// === Helper: AI call (OpenRouter) ===
async function callOpenRouter(userId, userText) {
  if (!OPENROUTER_API_KEY) throw new Error("Missing OpenRouter key");
  if (!memory.has(userId)) memory.set(userId, []);
  const convo = memory.get(userId);
  convo.push({ role: "user", content: userText });
  if (convo.length > 10) convo.splice(0, convo.length - 10);

  const body = {
    model: "openai/gpt-4o-mini",
    messages: [
      { role: "system", content: "You are a friendly Discord assistant. Keep answers concise." },
      ...convo
    ],
    max_tokens: 500
  };

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`OpenRouter error ${res.status}: ${txt}`);
  }
  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content?.trim() || "I couldn't think of a reply.";
  convo.push({ role: "assistant", content: reply });
  return reply;
}

// === Helper: message filtering ===
function shouldReply(message) {
  if (message.author.bot) return false;
  if (message.channel?.type === 1) return true; // DM
  if (message.mentions?.has(client.user)) return true;
  if (message.content.trim().toLowerCase().startsWith("!chat")) return true;
  return false;
}
function extractUserText(message) {
  let text = message.content.trim();
  if (text.toLowerCase().startsWith("!chat")) text = text.slice("!chat".length).trim();
  const mention = `<@${client.user.id}>`;
  const mentionNick = `<@!${client.user.id}>`;
  text = text.replaceAll(mention, "").replaceAll(mentionNick, "").trim();
  return text.length ? text : "Say hello!";
}

// === Slash commands list (includes moderation) ===
const commands = [
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask the AI something")
    .addStringOption(o => o.setName("question").setDescription("Your question").setRequired(true)),
  new SlashCommandBuilder().setName("help").setDescription("Show help menu"),
  new SlashCommandBuilder().setName("donate").setDescription("Support the bot"),
  // Moderation
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member")
    .addUserOption(o => o.setName("target").setDescription("Member to kick").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason")),
  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member")
    .addUserOption(o => o.setName("target").setDescription("Member to ban").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason")),
  new SlashCommandBuilder()
    .setName("mute")
    .setDescription("Temporarily timeout a member (in minutes)")
    .addUserOption(o => o.setName("target").setDescription("Member to mute").setRequired(true))
    .addIntegerOption(o => o.setName("minutes").setDescription("Duration in minutes").setRequired(true)),
  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a member")
    .addUserOption(o => o.setName("target").setDescription("Member to warn").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),
  new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("Show warnings for a member")
    .addUserOption(o => o.setName("target").setDescription("Member").setRequired(false)),
  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Bulk delete messages (admin only)")
    .addIntegerOption(o => o.setName("amount").setDescription("Number of messages").setRequired(true))
].map(c => c.toJSON());

// === Register slash commands ===
async function registerSlashCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("✅ Slash commands registered globally.");
  } catch (err) {
    console.error("Failed to register slash commands:", err);
  }
}

// === On ready ===
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerSlashCommands();

  // rotating presence
  const activities = [
    { name: "🧠 AI chat | /ask", type: 0 },
    { name: "💬 Use /ask in DM or server", type: 0 },
    { name: "⚙️ Mention me or use !chat", type: 0 },
    { name: "❤️ NKR.bot Online", type: 0 },
    { name: "📜 /help for commands", type: 0 },
    { name: "💡 You can DM me to ask questions!", type: 0 }
  ];
  let i = 0;
  setInterval(() => {
    client.user.setPresence({ status: "online", activities: [activities[i]] });
    i = (i + 1) % activities.length;
  }, 15000);

  await sendLog(client, `✅ NKR.bot is online as ${client.user.tag}`);
});

// === Interaction handler ===
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction.commandName;

  try {
    // AI ask
    if (cmd === "ask") {
      const question = interaction.options.getString("question");
      await interaction.deferReply();
      const reply = await callOpenRouter(interaction.user.id, question);
      await interaction.editReply(reply.slice(0, 2000));
      await sendLog(client, `💬 /ask by ${interaction.user.tag}: ${question}`);
    }

    // help
    if (cmd === "help") {
      await interaction.reply({
        embeds: [{ title: "NKR.bot Help", description: "**/ask** • Ask the AI\n**/donate** • Support\nModeration: /kick /ban /mute /warn /warnings /clear", color: 0x5865f2 }],
        ephemeral: true
      });
    }

    // donate
    if (cmd === "donate") {
      await interaction.reply({ content: "Support: https://ko-fi.com/yourlink", ephemeral: true });
    }

    // moderation: kick
    if (cmd === "kick") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.KickMembers)) return interaction.reply({ content: "You lack Kick Members permission.", ephemeral: true });
      const target = interaction.options.getUser("target");
      const reason = interaction.options.getString("reason") || "No reason provided";
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      if (!member) return interaction.reply({ content: "Member not found.", ephemeral: true });
      if (!member.kickable) return interaction.reply({ content: "I cannot kick that user.", ephemeral: true });
      await member.kick(reason);
      await interaction.reply(`✅ Kicked ${target.tag} — ${reason}`);
      await sendLog(client, `🔨 ${interaction.user.tag} kicked ${target.tag} — ${reason}`);
    }

    // ban
    if (cmd === "ban") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.BanMembers)) return interaction.reply({ content: "You lack Ban Members permission.", ephemeral: true });
      const target = interaction.options.getUser("target");
      const reason = interaction.options.getString("reason") || "No reason provided";
      await interaction.guild.members.ban(target.id, { reason }).catch(err => { throw err; });
      await interaction.reply(`✅ Banned ${target.tag} — ${reason}`);
      await sendLog(client, `🔨 ${interaction.user.tag} banned ${target.tag} — ${reason}`);
    }

    // mute (timeout)
    if (cmd === "mute") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.ModerateMembers)) return interaction.reply({ content: "You lack Moderate Members permission.", ephemeral: true });
      const target = interaction.options.getUser("target");
      const minutes = interaction.options.getInteger("minutes");
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      if (!member) return interaction.reply({ content: "Member not found.", ephemeral: true });
      const until = minutes > 0 ? Date.now() + minutes * 60 * 1000 : null;
      await member.timeout(minutes * 60 * 1000, `Muted by ${interaction.user.tag}`).catch(e => { throw e; });
      await interaction.reply(`🔇 ${target.tag} muted for ${minutes} minute(s).`);
      await sendLog(client, `🔇 ${interaction.user.tag} muted ${target.tag} for ${minutes} minutes.`);
    }

    // warn
    if (cmd === "warn") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.KickMembers)) return interaction.reply({ content: "You lack permission to warn.", ephemeral: true });
      const target = interaction.options.getUser("target");
      const reason = interaction.options.getString("reason") || "No reason provided";
      const warns = await loadWarnings();
      if (!warns[interaction.guild.id]) warns[interaction.guild.id] = {};
      if (!warns[interaction.guild.id][target.id]) warns[interaction.guild.id][target.id] = [];
      warns[interaction.guild.id][target.id].push({ moderator: interaction.user.tag, reason, time: new Date().toISOString() });
      await saveWarnings(warns);
      await interaction.reply(`⚠️ Warned ${target.tag}: ${reason}`);
      await sendLog(client, `⚠️ ${interaction.user.tag} warned ${target.tag}: ${reason}`);
    }

    // warnings
    if (cmd === "warnings") {
      const target = interaction.options.getUser("target") || interaction.user;
      const warns = await loadWarnings();
      const list = (warns[interaction.guild.id] && warns[interaction.guild.id][target.id]) || [];
      if (list.length === 0) return interaction.reply({ content: `${target.tag} has no warnings.`, ephemeral: true });
      const lines = list.map((w, i) => `${i + 1}. ${w.reason} — by ${w.moderator} on ${w.time}`).join("\n");
      await interaction.reply({ content: `Warnings for ${target.tag}:\n${lines}`, ephemeral: true });
    }

    // clear messages
    if (cmd === "clear") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageMessages)) return interaction.reply({ content: "You lack Manage Messages permission.", ephemeral: true });
      const amount = interaction.options.getInteger("amount");
      if (amount < 1 || amount > 100) return interaction.reply({ content: "Amount must be between 1 and 100.", ephemeral: true });
      const channel = interaction.channel;
      const deleted = await channel.bulkDelete(amount, true).catch(() => null);
      await interaction.reply({ content: `🧹 Deleted ${deleted?.size || 0} messages.`, ephemeral: true });
      await sendLog(client, `🧹 ${interaction.user.tag} deleted ${deleted?.size || 0} messages in #${channel.name}`);
    }

  } catch (err) {
    console.error("Interaction error:", err);
    await interaction.reply({ content: "⚠️ An error occurred while processing the command.", ephemeral: true });
    await sendLog(client, `⚠️ Command error: ${err.message}`);
  }
});

// === Message handler (AI via !chat or mention) ===
client.on("messageCreate", async message => {
  try {
    if (!shouldReply(message)) return;
    const text = extractUserText(message);
    await message.channel.sendTyping();
    const reply = await callOpenRouter(message.author.id, text);
    await sendLog(client, `💭 ${message.author.tag}: ${text}`);
    if (reply.length <= 2000) return message.reply(reply);
    const parts = reply.match(/[\s\S]{1,1900}/g) || [reply];
    for (const p of parts) await message.reply(p);
  } catch (err) {
    console.error("messageCreate error:", err);
    await sendLog(client, `⚠️ messageCreate error: ${err.message}`);
  }
});

// === Start bot ===
client.login(DISCORD_BOT_TOKEN).catch(err => {
  console.error("Failed to login:", err);
  process.exit(1);
});
