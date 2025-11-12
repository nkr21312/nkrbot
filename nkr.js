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
  PermissionFlagsBits,
  EmbedBuilder
} from "discord.js";
import fetch from "node-fetch";
import express from "express";
import fs from "fs/promises";
import path from "path";

// === Config ===
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID; // optional (for mod logs)

if (!DISCORD_BOT_TOKEN) {
  console.error("❌ Missing DISCORD_BOT_TOKEN in environment.");
  process.exit(1);
}

// === Discord Client ===
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

// === Keep-alive (for Render) ===
const app = express();
app.get("/", (req, res) => res.send("🧠 NKR.bot is alive!"));
app.listen(process.env.PORT || 3000, () => console.log("🌐 Keep-alive server running"));

// === Warning storage ===
const WARN_FILE = path.resolve("./warnings.json");
async function loadWarnings() {
  try {
    const raw = await fs.readFile(WARN_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
async function saveWarnings(obj) {
  await fs.writeFile(WARN_FILE, JSON.stringify(obj, null, 2), "utf8");
}

// === Conversation Memory ===
const memory = new Map();

// === Log Helper (Now Uses Embeds) ===
async function sendLogEmbed(client, title, description, color = 0x5865f2) {
  try {
    if (!LOG_CHANNEL_ID) return;
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (!channel?.isTextBased()) return;

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(color)
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error("Failed to send log:", err);
  }
}

// === AI (OpenRouter) ===
async function callOpenRouter(userId, userText) {
  if (!OPENROUTER_API_KEY) throw new Error("Missing OpenRouter key");
  if (!memory.has(userId)) memory.set(userId, []);
  const convo = memory.get(userId);
  convo.push({ role: "user", content: userText });
  if (convo.length > 10) convo.splice(0, convo.length - 10);

  const body = {
    model: "openai/gpt-4o-mini",
    messages: [
      { role: "system", content: "You are a friendly Discord assistant. Keep answers short and clear." },
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

  if (!res.ok) throw new Error(`OpenRouter error ${res.status}`);
  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content?.trim() || "I couldn’t think of a reply.";
  convo.push({ role: "assistant", content: reply });
  return reply;
}

// === Message detection ===
function shouldReply(message) {
  if (message.author.bot) return false;
  if (message.channel?.type === 1) return true;
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

// === Slash Commands ===
const commands = [
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask the AI something")
    .addStringOption(o => o.setName("question").setDescription("Your question").setRequired(true)),
  new SlashCommandBuilder().setName("help").setDescription("Show help menu"),
  new SlashCommandBuilder().setName("donate").setDescription("Support the bot"),
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member (mod only)")
    .addUserOption(o => o.setName("target").setDescription("Member to kick").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason")),
  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member (mod only)")
    .addUserOption(o => o.setName("target").setDescription("Member to ban").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason")),
  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a member (mod only)")
    .addUserOption(o => o.setName("target").setDescription("Member to warn").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason")),
  new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("Show warnings for a member")
    .addUserOption(o => o.setName("target").setDescription("Member").setRequired(false)),
  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Bulk delete messages (mod only)")
    .addIntegerOption(o => o.setName("amount").setDescription("Number of messages").setRequired(true)),
  new SlashCommandBuilder()
    .setName("mute")
    .setDescription("Temporarily mute a member (mod only)")
    .addUserOption(o => o.setName("target").setDescription("Member to mute").setRequired(true))
    .addIntegerOption(o => o.setName("minutes").setDescription("Mute duration (1–1440)").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason"))
].map(c => c.toJSON());

// === Register Commands ===
async function registerSlashCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("✅ Slash commands registered globally.");
  } catch (err) {
    console.error("Failed to register slash commands:", err);
  }
}

// === On Ready ===
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerSlashCommands();

  const activities = [
    { name: "🧠 AI chat | /ask", type: 0 },
    { name: "💬 Moderating servers", type: 0 },
    { name: "⚙️ Managing servers", type: 0 },
    { name: "❤️ NKR.bot Online", type: 0 },
    { name: "📜 /help for commands", type: 0 }
  ];
  let i = 0;
  setInterval(() => {
    client.user.setPresence({ status: "online", activities: [activities[i]] });
    i = (i + 1) % activities.length;
  }, 15000);
});

// === Interaction Handler ===
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction.commandName;

  const MOD_ROLES = ["Moderator", "Admin", "Staff"];
  function isModerator(member) {
    return (
      member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.roles.cache.some(role => MOD_ROLES.includes(role.name))
    );
  }

  try {
    // === AI ===
    if (cmd === "ask") {
      const question = interaction.options.getString("question");
      await interaction.deferReply();
      const reply = await callOpenRouter(interaction.user.id, question);
      await interaction.editReply(reply.slice(0, 2000));
      await sendLogEmbed(client, "💬 AI Interaction", `${interaction.user.tag}: ${question}`);
    }

    // === Help ===
    if (cmd === "help") {
      await interaction.reply({
        embeds: [{
          title: "🧠 NKR.bot Help",
          description: "**/ask** — Chat with AI\n**/donate** — Support the bot\n**Moderation:** /kick /ban /warn /mute /clear /warnings",
          color: 0x5865f2
        }],
        ephemeral: true
      });
    }

    // === Donate ===
    if (cmd === "donate") {
      await interaction.reply({ content: "Support ❤️: https://ko-fi.com/yourlink", ephemeral: true });
    }

    // === Kick ===
    if (cmd === "kick") {
      if (!isModerator(interaction.member)) return interaction.reply({ content: "🚫 Only moderators can use /kick.", ephemeral: true });
      const target = interaction.options.getUser("target");
      const reason = interaction.options.getString("reason") || "No reason provided";
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      if (!member) return interaction.reply({ content: "Member not found.", ephemeral: true });
      if (!member.kickable) return interaction.reply({ content: "I cannot kick that user.", ephemeral: true });
      await member.kick(reason);
      await interaction.reply(`✅ Kicked ${target.tag} — ${reason}`);
      await sendLogEmbed(client, "🔨 Member Kicked", `**Moderator:** ${interaction.user.tag}\n**User:** ${target.tag}\n**Reason:** ${reason}`, 0xffa500);
    }

    // === Ban ===
    if (cmd === "ban") {
      if (!isModerator(interaction.member)) return interaction.reply({ content: "🚫 Only moderators can use /ban.", ephemeral: true });
      const target = interaction.options.getUser("target");
      const reason = interaction.options.getString("reason") || "No reason provided";
      await interaction.guild.members.ban(target.id, { reason });
      await interaction.reply(`✅ Banned ${target.tag} — ${reason}`);
      await sendLogEmbed(client, "⛔ Member Banned", `**Moderator:** ${interaction.user.tag}\n**User:** ${target.tag}\n**Reason:** ${reason}`, 0xff0000);
    }

    // === Warn ===
    if (cmd === "warn") {
      if (!isModerator(interaction.member)) return interaction.reply({ content: "🚫 Only moderators can use /warn.", ephemeral: true });
      const target = interaction.options.getUser("target");
      const reason = interaction.options.getString("reason") || "No reason provided";
      const warns = await loadWarnings();
      if (!warns[interaction.guild.id]) warns[interaction.guild.id] = {};
      if (!warns[interaction.guild.id][target.id]) warns[interaction.guild.id][target.id] = [];
      warns[interaction.guild.id][target.id].push({ moderator: interaction.user.tag, reason, time: new Date().toISOString() });
      await saveWarnings(warns);
      await interaction.reply(`⚠️ Warned ${target.tag}: ${reason}`);
      await sendLogEmbed(client, "⚠️ Member Warned", `**Moderator:** ${interaction.user.tag}\n**User:** ${target.tag}\n**Reason:** ${reason}`, 0xffff00);
    }

    // === Mute ===
    if (cmd === "mute") {
      if (!isModerator(interaction.member)) return interaction.reply({ content: "🚫 Only moderators can use /mute.", ephemeral: true });
      const target = interaction.options.getUser("target");
      const minutes = interaction.options.getInteger("minutes");
      const reason = interaction.options.getString("reason") || "No reason provided";
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      if (!member) return interaction.reply({ content: "Member not found.", ephemeral: true });

      const durationMs = minutes * 60 * 1000;
      await member.timeout(durationMs, reason);
      await interaction.reply(`🔇 ${target.tag} muted for ${minutes} minute(s).`);
      await sendLogEmbed(client, "🔇 Member Muted", `**Moderator:** ${interaction.user.tag}\n**User:** ${target.tag}\n**Duration:** ${minutes} min\n**Reason:** ${reason}`, 0x3498db);

      setTimeout(async () => {
        try {
          const refreshed = await interaction.guild.members.fetch(target.id);
          if (refreshed.isCommunicationDisabled()) {
            await refreshed.timeout(null);
            await sendLogEmbed(client, "🔊 Member Unmuted (Auto)", `**User:** ${target.tag}\n**After:** ${minutes} minutes`, 0x00ff00);
          }
        } catch {}
      }, durationMs);
    }

    // === Clear ===
    if (cmd === "clear") {
      if (!isModerator(interaction.member)) return interaction.reply({ content: "🚫 Only moderators can use /clear.", ephemeral: true });
      const amount = interaction.options.getInteger("amount");
      if (amount < 1 || amount > 100) return interaction.reply({ content: "❌ Must be between 1–100.", ephemeral: true });
      const deleted = await interaction.channel.bulkDelete(amount, true);
      await interaction.reply({ content: `🧹 Deleted ${deleted.size} messages.`, ephemeral: true });
      await sendLogEmbed(client, "🧹 Messages Cleared", `**Moderator:** ${interaction.user.tag}\n**Deleted:** ${deleted.size} messages`, 0x95a5a6);
    }

    // === Warnings ===
    if (cmd === "warnings") {
      const target = interaction.options.getUser("target") || interaction.user;
      const warns = await loadWarnings();
      const list = (warns[interaction.guild.id] && warns[interaction.guild.id][target.id]) || [];
      if (list.length === 0) return interaction.reply({ content: `${target.tag} has no warnings.`, ephemeral: true });
      const lines = list.map((w, i) => `${i + 1}. ${w.reason} — by ${w.moderator} (${w.time})`).join("\n");
      await interaction.reply({ embeds: [{ title: `⚠️ Warnings for ${target.tag}`, description: lines, color: 0xffff00 }], ephemeral: true });
    }
  } catch (err) {
    console.error("Interaction error:", err);
    if (!interaction.replied)
      await interaction.reply({ content: "⚠️ An error occurred.", ephemeral: true });
  }
});

// === AI Message Handler (!chat / mention) ===
client.on("messageCreate", async message => {
  try {
    if (!shouldReply(message)) return;
    const text = extractUserText(message);
    await message.channel.sendTyping();
    const reply = await callOpenRouter(message.author.id, text);
    if (reply.length <= 2000) return message.reply(reply);
    const parts = reply.match(/[\s\S]{1,1900}/g) || [reply];
    for (const p of parts) await message.reply(p);
  } catch (err) {
    console.error("Message error:", err);
  }
});

// === Start Bot ===
client.login(DISCORD_BOT_TOKEN).catch(err => {
  console.error("Failed to login:", err);
  process.exit(1);
});
