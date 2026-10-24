// bot.js
// === Load environment variables ===
import dotenv from "dotenv";
dotenv.config({ path: "./tokens.env" });

import { MongoClient } from "mongodb";

// === Imports ===
import {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionFlagsBits,
  ChannelType
} from "discord.js";
import fetch from "node-fetch";
import express from "express";
import { createDashboard, createLinkCode, SETTINGS_DEFAULTS } from "./dashboard.js";

// === Config / tokens ===
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID; // optional, set in Render
const DASHBOARD_URL = (process.env.DASHBOARD_URL || "").replace(/\/$/, ""); // e.g. https://your-app.onrender.com

// ===== SERVER CONFIGURATION (IMPORTANT) =====
// NKR Server
const NKR_SERVER_ID = "1255904591875280997";

// Group Server (where XP and restricted AI work)
const GROUP_SERVER_ID = "1155780893311520788";
const GROUP_LEVEL_UP_CHANNEL_ID = process.env.LEVEL_UP_CHANNEL_ID; // for level-up announcements
const GROUP_AI_CHANNEL_ID = "1169991875709636628"; // ONLY channel where AI works in Group server

if (!DISCORD_BOT_TOKEN) {
  console.error("Missing DISCORD_BOT_TOKEN in environment. Exiting.");
  process.exit(1);
}

const mongoClient = new MongoClient(process.env.MONGO_URI);
await mongoClient.connect();
console.log("✅ MongoDB connected");

const db = mongoClient.db("nkrbot");
const levelsCollection = db.collection("levels");
const warningsCollection = db.collection("warnings");
const guildConfigCollection = db.collection("guildConfig");
const modActionsCollection = db.collection("modActions"); // NEW: feeds the dashboard's "recent actions"

// === Leveling System Config (GROUP SERVER ONLY) ===
const XP_PER_MESSAGE = 10; // Base XP per message
const LEVEL_MULTIPLIER = 1.2; // Each level requires 20% more XP (1.2x)

// Calculate XP needed for a level
function getXPForLevel(level) {
  return Math.floor(XP_PER_MESSAGE * Math.pow(LEVEL_MULTIPLIER, level - 1));
}

// Calculate cumulative XP needed to reach a level
function getTotalXPForLevel(level) {
  let total = 0;
  for (let i = 1; i < level; i++) {
    total += getXPForLevel(i);
  }
  return total;
}

// Add XP to user and check for level up
async function addXPToUser(guildId, userId, xpAmount = XP_PER_MESSAGE) {
  let userData = await levelsCollection.findOne({ guildId, userId });

  if (!userData) {
    userData = { guildId, userId, level: 1, totalXP: 0 };
  }

  const oldLevel = userData.level;
  userData.totalXP += xpAmount;

  let newLevel = userData.level;
  while (getTotalXPForLevel(newLevel + 1) <= userData.totalXP) {
    newLevel++;
  }
  userData.level = newLevel;

  await levelsCollection.updateOne(
    { guildId, userId },
    { $set: { level: userData.level, totalXP: userData.totalXP } },
    { upsert: true }
  );

  return {
    xpAdded: xpAmount,
    newLevel,
    oldLevel,
    totalXP: userData.totalXP,
    leveledUp: newLevel > oldLevel
  };
}

// Get user level info
async function getUserLevelInfo(guildId, userId) {
  const userData = await levelsCollection.findOne({ guildId, userId });

  if (!userData) {
    return {
      level: 1,
      totalXP: 0,
      xpInCurrentLevel: 0,
      xpNeededForThisLevel: getXPForLevel(1),
      xpForNextLevel: getXPForLevel(2)
    };
  }

  const xpNeededForCurrentLevel = getTotalXPForLevel(userData.level);
  const xpNeededForNextLevel = getTotalXPForLevel(userData.level + 1);

  return {
    level: userData.level,
    totalXP: userData.totalXP,
    xpInCurrentLevel: userData.totalXP - xpNeededForCurrentLevel,
    xpNeededForThisLevel: xpNeededForNextLevel - xpNeededForCurrentLevel,
    xpForNextLevel: xpNeededForNextLevel
  };
}

// Get leaderboard
async function getLeaderboard(guildId, limit = 10) {
  return await levelsCollection
    .find({ guildId })
    .sort({ level: -1, totalXP: -1 })
    .limit(limit)
    .toArray();
}

// ===== Per-guild config (shared by slash commands AND the web dashboard) =====
// Defaults come from the dashboard's settings schema so the website and bot never drift apart
const DEFAULT_GUILD_CONFIG = SETTINGS_DEFAULTS;

// Simple in-memory cache so we don't hit Mongo on every message / mod action
const guildConfigCache = new Map();

async function getGuildConfig(guildId) {
  if (guildConfigCache.has(guildId)) return guildConfigCache.get(guildId);
  const doc = await guildConfigCollection.findOne({ guildId });
  // XP stays on by default in the Group Server (as before); every other server opts in from the dashboard
  const cfg = { ...DEFAULT_GUILD_CONFIG, ...(guildId === GROUP_SERVER_ID ? { xpEnabled: true } : {}), ...(doc || {}) };
  guildConfigCache.set(guildId, cfg);
  return cfg;
}

async function setGuildConfig(guildId, patch) {
  await guildConfigCollection.updateOne(
    { guildId },
    { $set: { guildId, ...patch } },
    { upsert: true }
  );
  const current = await getGuildConfig(guildId);
  guildConfigCache.set(guildId, { ...current, ...patch });
}

async function setModLogChannel(guildId, channelId) {
  await setGuildConfig(guildId, { modLogChannelId: channelId });
}

async function getModLogChannelId(guildId) {
  return (await getGuildConfig(guildId)).modLogChannelId || null;
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

// === Web server (Render keep-alive + dashboard) ===
const app = express();
app.set("trust proxy", 1); // Render sits behind a proxy; needed for secure cookies + rate limiting
app.disable("x-powered-by");

app.get("/", (req, res) => res.send("🧠 NKR.bot is alive!"));

app.use(
  "/dashboard",
  createDashboard({ client, db, mongoClient, getGuildConfig, setGuildConfig })
);

app.listen(process.env.PORT || 3000, () =>
  console.log("🌐 Web server running (keep-alive + /dashboard)")
);

// Send mod action DM to user (now as an embed)
async function sendModActionDM(client, guild, userId, action, reason, duration = null) {
  try {
    const cfg = await getGuildConfig(guild.id);
    if (!cfg.dmOnAction) return;
    const guildName = guild.name;
    const user = await client.users.fetch(userId);

    const embed = {
      color: 0x5865f2,
      title: `📋 ${action}`,
      fields: [
        { name: "🏠 Server", value: guildName, inline: true },
        { name: "📝 Reason", value: reason || "No reason provided", inline: true }
      ],
      timestamp: new Date()
    };

    if (duration) {
      embed.fields.push({ name: "⏱ Duration", value: duration, inline: true });
    }

    await user.send({ embeds: [embed] });
  } catch (err) {
    if (err.code !== 50007 && err.code !== 50278) {
      console.error(`Failed to send DM to ${userId}:`, err);
    }
  }
}

// Records every mod action (shown on the dashboard) and posts to the guild's mod-log channel.
async function sendPublicModMessage(client, guildId, action, target, moderator, reason, extra = {}) {
  // 1) Always record to Mongo for the dashboard, even if no mod-log channel is configured
  modActionsCollection
    .insertOne({
      guildId,
      action,
      targetId: target.id,
      targetTag: target.tag,
      moderatorId: moderator.id,
      moderatorTag: moderator.tag,
      reason: reason || "No reason provided",
      duration: extra.duration || null,
      time: new Date()
    })
    .catch(err => console.error("Failed to record mod action:", err));

  // 2) Post to the configured mod-log channel
  try {
    const channelId = await getModLogChannelId(guildId);
    if (!channelId) return; // this server hasn't set a mod-log channel yet

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    const embed = {
      color: extra.color || 0xff0000,
      title: `🚨 ${action}`,
      fields: [
        { name: "👤 User", value: `<@${target.id}> (${target.tag})`, inline: true },
        { name: "🛡 Moderator", value: `<@${moderator.id}>`, inline: true },
        { name: "📝 Reason", value: reason || "No reason provided" }
      ],
      timestamp: new Date()
    };

    if (extra.duration) {
      embed.fields.push({ name: "⏱ Duration", value: extra.duration });
    }

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error("Failed to send public mod message:", err);
  }
}

// Send level-up message to dedicated channel (GROUP SERVER ONLY)
async function sendLevelUpMessage(client, userId, newLevel, totalXP, guildId) {
  try {
    const lvCfg = await getGuildConfig(guildId);
    const channelId = lvCfg.levelUpChannelId || (guildId === GROUP_SERVER_ID ? GROUP_LEVEL_UP_CHANNEL_ID : null);
    if (!channelId) return;

    const channel = await client.channels.fetch(channelId);
    if (channel && channel.isTextBased()) {
      const user = await client.users.fetch(userId).catch(() => null);

      const levelUpEmbed = {
        color: 0xFFD700,
        title: "🎉 Level Up!",
        description: `<@${userId}> reached **Level ${newLevel}**!`,
        thumbnail: user ? { url: user.displayAvatarURL() } : undefined,
        fields: [
          { name: "New Level", value: `${newLevel}`, inline: true },
          { name: "Total XP", value: `${totalXP}`, inline: true }
        ],
        timestamp: new Date()
      };

      await channel.send({ embeds: [levelUpEmbed] });
    }
  } catch (err) {
    console.error("Failed to send level-up message:", err);
  }
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

// === Helper: AI call (Groq) ===
async function callGroq(userId, userText, systemPrompt) {
  if (!GROQ_API_KEY) throw new Error("Missing Groq key");

  if (!memory.has(userId)) memory.set(userId, []);
  const convo = memory.get(userId);

  convo.push({ role: "user", content: userText });
  if (convo.length > 10) convo.splice(0, convo.length - 10);

  const body = {
    model: "openai/gpt-oss-120b",
    messages: [
      { role: "system", content: systemPrompt || "You are a friendly Discord assistant. Keep answers concise." },
      ...convo
    ],
    max_tokens: 500
  };

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error("Groq API error:", res.status, txt);
    await sendLog(client, `⚠️ Groq API error ${res.status}: ${txt.slice(0, 500)}`);
    return "⚠️ I'm having trouble reaching the AI service right now. Try again in a bit!";
  }

  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content?.trim() || "I couldn't think of a reply.";

  convo.push({ role: "assistant", content: reply });
  return reply;
}

// === Helper: message filtering ===
function shouldReply(message, cfg) {
  if (message.author.bot) return false;

  // Allow DMs (works for both servers)
  if (message.channel?.type === 1) return true;

  // Detect AI trigger
  const isAIMessage =
    message.content.trim().startsWith("!") ||
    message.mentions?.has(client.user);

  // Ignore normal messages
  if (!isAIMessage) return false;

  // Per-server AI channel from the dashboard (Group Server keeps its old fixed channel as fallback)
  if (message.guild) {
    const restrictTo = cfg?.aiChannelId || (message.guild.id === GROUP_SERVER_ID ? GROUP_AI_CHANNEL_ID : null);
    if (restrictTo && message.channel.id !== restrictTo) return false;
  }

  // For NKR SERVER: AI works in all channels
  return true;
}

function extractUserText(message) {
  let text = message.content.trim();
  if (text.toLowerCase().startsWith("!")) text = text.slice("!".length).trim();

  const mention = `<@${client.user.id}>`;
  const mentionNick = `<@!${client.user.id}>`;
  text = text.replaceAll(mention, "").replaceAll(mentionNick, "").trim();

  return text.length ? text : "Say hello!";
}

// === Slash commands list ===
const commands = [
  // AI command (global)
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask the AI something")
    .addStringOption(o => o.setName("question").setDescription("Your question").setRequired(true)),

  new SlashCommandBuilder().setName("help").setDescription("Show help menu"),
  new SlashCommandBuilder().setName("donate").setDescription("Support the bot"),

  // ===== LEVELING COMMANDS (GROUP SERVER ONLY) =====
  new SlashCommandBuilder()
    .setName("level")
    .setDescription("Check your level and XP")
    .setDMPermission(false)
    .addUserOption(o => o.setName("user").setDescription("User to check (optional)")),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Show top 10 users by level")
    .setDMPermission(false),

  // ===== MODERATION COMMANDS (GLOBAL - all servers) =====
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

  // ===== NEW: softban (ban + immediate unban = kick that also wipes recent messages) =====
  new SlashCommandBuilder()
    .setName("softban")
    .setDescription("Ban then instantly unban a member to purge their recent messages")
    .addUserOption(o => o.setName("target").setDescription("Member to softban").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason"))
    .addIntegerOption(o =>
      o.setName("deletedays")
        .setDescription("Delete messages from the last N days (0-7). Default: server setting")
        .setMinValue(0)
        .setMaxValue(7)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Unban a user")
    .addStringOption(o => o.setName("userid").setDescription("User ID to unban").setRequired(true)),

  new SlashCommandBuilder()
    .setName("mute")
    .setDescription("Mute a member")
    .addUserOption(o => o.setName("target").setDescription("Member to mute").setRequired(true))
    .addIntegerOption(o => o.setName("minutes").setDescription("Duration in minutes").setRequired(true)),

  new SlashCommandBuilder()
    .setName("unmute")
    .setDescription("Unmute a member")
    .addUserOption(o => o.setName("target").setDescription("Member to unmute").setRequired(true)),

  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a member")
    .addUserOption(o => o.setName("target").setDescription("Member to warn").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason")),

  new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("Check warnings")
    .addUserOption(o => o.setName("user").setDescription("User to check (default: self)")),

  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Clear messages")
    .addIntegerOption(o => o.setName("amount").setDescription("Number of messages").setRequired(true)),

  // Set the channel for global mod messages (per server)
  new SlashCommandBuilder()
    .setName("setmodlog")
    .setDescription("Set the channel where global mod action messages are posted (this server only)")
    .addChannelOption(o =>
      o.setName("channel")
        .setDescription("The text channel to post mod actions in")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // ===== NEW: get a one-time code to link this server to the web dashboard =====
  new SlashCommandBuilder()
    .setName("dashboard")
    .setDescription("Get a one-time code to link this server to the web dashboard")
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
];

// === Register slash commands ===
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const rest = new REST().setToken(DISCORD_BOT_TOKEN);

  try {
    // Every command is global now (leveling is switched on per server from the dashboard)
    const allCommands = commands.map(cmd => cmd.toJSON());

    // Clear the old Group-Server-only copies so /level and /leaderboard don't show twice
    if (GROUP_SERVER_ID) {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, GROUP_SERVER_ID),
        { body: [] }
      );
    }

    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: allCommands }
    );
    console.log("✅ Global commands registered!");
  } catch (err) {
    console.error("Failed to register commands:", err);
  }

  // === Rotating status ===
  const activities = [
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
      let aiPrompt;
      if (interaction.guild) {
        const cfg = await getGuildConfig(interaction.guild.id);
        if (!cfg.aiEnabled) {
          return interaction.reply({ content: "❌ AI replies are disabled in this server.", flags: 64 });
        }
        aiPrompt = cfg.aiPersonality;
      }

      const question = interaction.options.getString("question");
      await interaction.deferReply();

      const reply = await callGroq(interaction.user.id, question, aiPrompt);
      await interaction.editReply(reply.slice(0, 2000));
      await sendLog(client, `💬 /ask by ${interaction.user.tag}: ${question}`);
    }

    // help
    if (cmd === "help") {
      await interaction.reply({
        embeds: [{
          title: "NKR.bot Help",
          description:
            "**/ask** • Ask the AI\n**/donate** • Support\n**/level** • Check your level (Group Server)\n**/leaderboard** • See top users (Group Server)\n" +
            "**/setmodlog** • Set this server's mod-log channel (Manage Server)\n**/dashboard** • Get a code to link this server to the web dashboard (Manage Server)\n\n" +
            "**Moderation:** /kick /ban /softban /unban /mute /unmute /warn /warnings /clear",
          color: 0x5865f2
        }],
        flags: 64
      });
    }

    // donate
    if (cmd === "donate") {
      await interaction.reply({ content: "Support: https://ko-fi.com/yourlink", flags: 64 });
    }

    // setmodlog
    if (cmd === "setmodlog") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: "❌ You need the Manage Server permission to use this.", flags: 64 });
      }

      const channel = interaction.options.getChannel("channel");
      if (!channel || channel.type !== ChannelType.GuildText) {
        return interaction.reply({ content: "❌ Please choose a text channel.", flags: 64 });
      }

      await setModLogChannel(interaction.guild.id, channel.id);
      await interaction.reply({ content: `✅ Global mod action messages will now be posted in <#${channel.id}> for this server.`, flags: 64 });
      await sendLog(client, `⚙️ ${interaction.user.tag} set mod-log channel for ${interaction.guild.name} to #${channel.name}`);
    }

    // ===== NEW: dashboard link code =====
    if (cmd === "dashboard") {
      if (!interaction.guild) {
        return interaction.reply({ content: "❌ Use this inside a server.", flags: 64 });
      }
      if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: "❌ You need the Manage Server permission to use this.", flags: 64 });
      }
      if (process.env.DASHBOARD_OWNER_ONLY === "true" && interaction.user.id !== interaction.guild.ownerId) {
        return interaction.reply({ content: "❌ Only the server owner can use this command.", flags: 64 });
      }
      if (!DASHBOARD_URL) {
        return interaction.reply({ content: "⚠️ The dashboard URL isn't configured (DASHBOARD_URL).", flags: 64 });
      }

      const code = await createLinkCode(db, interaction.guild.id, interaction.user.id);
      await interaction.reply({
        content:
          `🔗 **Dashboard link code:** \`${code}\`\n` +
          `1. Open ${DASHBOARD_URL}/dashboard and log in (or register)\n` +
          `2. Paste the code under **Link a server**\n\n` +
          `The code works once and expires in 10 minutes. Don't share it.`,
        flags: 64
      });
      await sendLog(client, `🔗 ${interaction.user.tag} generated a dashboard link code for ${interaction.guild.name}`);
    }

    // ===== LEVELING COMMANDS (GROUP SERVER ONLY) =====
    if (cmd === "level") {
      if (!(await getGuildConfig(interaction.guild.id)).xpEnabled) {
        return interaction.reply({ content: "❌ Leveling is disabled in this server. An admin can enable it in the dashboard.", flags: 64 });
      }

      const user = interaction.options.getUser("user") || interaction.user;
      const levelInfo = await getUserLevelInfo(interaction.guild.id, user.id);

      const progressPercent = Math.round(
        (levelInfo.xpInCurrentLevel / levelInfo.xpNeededForThisLevel) * 100
      );
      const progressBar = "█".repeat(Math.floor(progressPercent / 5)) + "░".repeat(20 - Math.floor(progressPercent / 5));

      const embed = {
        color: 0x5865f2,
        title: `📊 ${user.username}'s Level Info`,
        thumbnail: { url: user.displayAvatarURL() },
        fields: [
          { name: "🎖️ Level", value: `${levelInfo.level}`, inline: true },
          { name: "⭐ Total XP", value: `${levelInfo.totalXP}`, inline: true },
          { name: "📈 Progress", value: `${progressBar} ${progressPercent}%`, inline: false },
          { name: "🎯 XP in Level", value: `${levelInfo.xpInCurrentLevel}/${levelInfo.xpNeededForThisLevel}`, inline: true },
          { name: "📍 XP to Next Level", value: `${levelInfo.xpNeededForThisLevel - levelInfo.xpInCurrentLevel}`, inline: true }
        ]
      };

      await interaction.reply({ embeds: [embed] });
    }

    if (cmd === "leaderboard") {
      if (!(await getGuildConfig(interaction.guild.id)).xpEnabled) {
        return interaction.reply({ content: "❌ Leveling is disabled in this server. An admin can enable it in the dashboard.", flags: 64 });
      }

      const users = await getLeaderboard(interaction.guild.id, 10);
      if (users.length === 0) {
        return interaction.reply({ content: "No users have leveled up yet!", flags: 64 });
      }

      let description = "";
      for (let i = 0; i < users.length; i++) {
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`;
        description += `${medal} <@${users[i].userId}> - Level **${users[i].level}** (${users[i].totalXP} XP)\n`;
      }

      const embed = {
        color: 0xFFD700,
        title: "🏆 Leaderboard",
        description,
        footer: { text: "Top 10 Most Active Users" }
      };

      await interaction.reply({ embeds: [embed] });
    }

    // ===== MODERATION COMMANDS (GLOBAL) =====

    // kick
    if (cmd === "kick") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.KickMembers)) {
        return interaction.reply({ content: "❌ You lack Kick Members permission.", flags: 64 });
      }

      const target = interaction.options.getUser("target");
      const reason = interaction.options.getString("reason") || "No reason provided";
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);

      if (!member) return interaction.reply({ content: "Member not found.", flags: 64 });
      if (!member.kickable) return interaction.reply({ content: "I cannot kick that user.", flags: 64 });

      await sendModActionDM(client, interaction.guild, target.id, "Kicked from server", reason);
      await member.kick(reason);

      await interaction.reply(`✅ Kicked ${target.tag} — ${reason}`);
      await sendLog(client, `🔨 ${interaction.user.tag} kicked ${target.tag} — ${reason}`);
      await sendPublicModMessage(client, interaction.guild.id, "User Kicked", target, interaction.user, reason, { color: 0xFFA500 });
    }

    // ban
    if (cmd === "ban") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.BanMembers)) {
        return interaction.reply({ content: "❌ You lack Ban Members permission.", flags: 64 });
      }

      const target = interaction.options.getUser("target");
      const reason = interaction.options.getString("reason") || "No reason provided";

      await sendModActionDM(client, interaction.guild, target.id, "Banned from server", reason);
      await interaction.guild.members.ban(target.id, { reason });

      await interaction.reply({ content: `✅ Banned ${target.tag}`, flags: 64 });
      await sendLog(client, `🔨 ${interaction.user.tag} banned ${target.tag} — ${reason}`);
      await sendPublicModMessage(client, interaction.guild.id, "User Banned", target, interaction.user, reason, { color: 0xff0000 });
    }

    // ===== NEW: softban =====
    if (cmd === "softban") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.BanMembers)) {
        return interaction.reply({ content: "❌ You lack Ban Members permission.", flags: 64 });
      }

      const target = interaction.options.getUser("target");
      const reason = interaction.options.getString("reason") || "No reason provided";
      const cfg = await getGuildConfig(interaction.guild.id);
      const days = interaction.options.getInteger("deletedays") ?? cfg.softbanDeleteDays;

      if (target.id === interaction.user.id) {
        return interaction.reply({ content: "❌ You can't softban yourself.", flags: 64 });
      }
      if (target.id === client.user.id) {
        return interaction.reply({ content: "❌ I won't softban myself.", flags: 64 });
      }
      if (target.id === interaction.guild.ownerId) {
        return interaction.reply({ content: "❌ You can't softban the server owner.", flags: 64 });
      }

      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      if (!member) {
        return interaction.reply({ content: "❌ That user isn't in this server, so there's nothing to softban.", flags: 64 });
      }
      if (!member.bannable) {
        return interaction.reply({ content: "❌ I can't softban that user (their role is above mine, or I lack permission).", flags: 64 });
      }
      if (
        interaction.guild.ownerId !== interaction.user.id &&
        member.roles.highest.position >= interaction.member.roles.highest.position
      ) {
        return interaction.reply({ content: "❌ That user's highest role is equal to or above yours.", flags: 64 });
      }

      await interaction.deferReply({ flags: 64 });

      // DM BEFORE the ban — after it, the bot may no longer share a server with them
      await sendModActionDM(client, interaction.guild,
        target.id,
        "Softbanned (kicked + recent messages deleted). You can rejoin with a new invite.",
        reason
      );

      await interaction.guild.members.ban(target.id, {
        reason: `[Softban] ${reason} — by ${interaction.user.tag}`,
        deleteMessageSeconds: days * 86400
      });

      try {
        await interaction.guild.members.unban(target.id, `[Softban release] by ${interaction.user.tag}`);
      } catch (err) {
        console.error("Softban: unban step failed:", err);
        await sendLog(client, `🚨 Softban unban FAILED for ${target.tag} in ${interaction.guild.name}: ${err.message}`);
        await interaction.editReply(`⚠️ ${target.tag} was banned and their messages deleted, but the automatic unban failed. They are still banned — use /unban ${target.id}.`);
        await sendPublicModMessage(client, interaction.guild.id, "User Banned (softban unban failed)", target, interaction.user, reason, { color: 0xff0000 });
        return;
      }

      await interaction.editReply(`✅ Softbanned ${target.tag} — deleted ${days} day(s) of messages. They can rejoin.`);
      await sendLog(client, `🧹 ${interaction.user.tag} softbanned ${target.tag} (${days}d purge) — ${reason}`);
      await sendPublicModMessage(client, interaction.guild.id, "User Softbanned", target, interaction.user, reason, {
        color: 0xE67E22,
        duration: `${days} day(s) of messages deleted`
      });
    }

    // unban
    if (cmd === "unban") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.BanMembers)) {
        return interaction.reply({ content: "❌ You lack Ban Members permission.", flags: 64 });
      }

      const userId = interaction.options.getString("userid");

      try {
        await interaction.guild.members.unban(userId);
        await interaction.reply(`✅ Unbanned user with ID ${userId}`);
        await sendLog(client, `♻️ ${interaction.user.tag} unbanned ${userId}`);

        await sendModActionDM(client, interaction.guild, userId, "Unbanned from server", "Unban");
        await sendPublicModMessage(
          client,
          interaction.guild.id,
          "User Unbanned",
          { id: userId, tag: `ID:${userId}` },
          interaction.user,
          "Unban",
          { color: 0x2ECC71 }
        );
      } catch (err) {
        await interaction.reply({ content: "Failed to unban. Check the user ID.", flags: 64 });
      }
    }

    // mute (timeout)
    if (cmd === "mute") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.ModerateMembers)) {
        return interaction.reply({ content: "❌ You lack Moderate Members permission.", flags: 64 });
      }

      const target = interaction.options.getUser("target");
      const minutes = interaction.options.getInteger("minutes");
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);

      if (!member) return interaction.reply({ content: "Member not found.", flags: 64 });

      await member.timeout(minutes * 60 * 1000, `Muted by ${interaction.user.tag}`);
      await interaction.reply(`🔇 ${target.tag} muted for ${minutes} minute(s).`);

      await sendModActionDM(client, interaction.guild, target.id, "Muted on server", "Timeout applied", `${minutes} minute(s)`);
      await sendPublicModMessage(
        client,
        interaction.guild.id,
        "User Muted",
        target,
        interaction.user,
        "Timeout",
        { duration: `${minutes} minute(s)`, color: 0xFFD700 }
      );
    }

    // unmute (remove timeout)
    if (cmd === "unmute") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.ModerateMembers)) {
        return interaction.reply({ content: "❌ You lack Moderate Members permission.", flags: 64 });
      }

      const target = interaction.options.getUser("target");
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);

      if (!member) {
        return interaction.reply({ content: "Member not found.", flags: 64 });
      }

      await member.timeout(null, `Unmuted by ${interaction.user.tag}`);
      await interaction.reply(`🔊 ${target.tag} has been unmuted.`);
      await sendLog(client, `🔊 ${interaction.user.tag} unmuted ${target.tag}`);

      await sendModActionDM(client, interaction.guild, target.id, "Unmuted from server", "Timeout removed");
      await sendPublicModMessage(
        client,
        interaction.guild.id,
        "User Unmuted",
        target,
        interaction.user,
        "Timeout removed",
        { color: 0x2ECC71 }
      );
    }

    // warn
    if (cmd === "warn") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.KickMembers)) {
        return interaction.reply({ content: "❌ You lack permission to warn.", flags: 64 });
      }

      const target = interaction.options.getUser("target");
      const reason = interaction.options.getString("reason") || "No reason provided";

      await warningsCollection.insertOne({
        guildId: interaction.guild.id,
        userId: target.id,
        moderator: interaction.user.tag,
        reason,
        time: new Date().toISOString()
      });

      await interaction.reply(`⚠️ Warned ${target.tag}: ${reason}`);
      await sendLog(client, `⚠️ ${interaction.user.tag} warned ${target.tag}: ${reason}`);

      await sendModActionDM(client, interaction.guild, target.id, "Warning on server", reason);
      await sendPublicModMessage(client, interaction.guild.id, "User Warned", target, interaction.user, reason, { color: 0xFFA500 });

      // Auto-punishment once the warning threshold is reached (set in the dashboard)
      const warnCfg = await getGuildConfig(interaction.guild.id);
      if (warnCfg.warnThreshold > 0) {
        const total = await warningsCollection.countDocuments({ guildId: interaction.guild.id, userId: target.id });
        if (total % warnCfg.warnThreshold === 0) {
          try {
            const m = await interaction.guild.members.fetch(target.id).catch(() => null);
            let done = null;
            if (m && warnCfg.warnAction === "mute" && m.moderatable) {
              await m.timeout(warnCfg.warnMuteMinutes * 60 * 1000, `Auto: reached ${total} warnings`);
              done = `muted for ${warnCfg.warnMuteMinutes} minute(s)`;
            } else if (m && warnCfg.warnAction === "kick" && m.kickable) {
              await m.kick(`Auto: reached ${total} warnings`);
              done = "kicked";
            } else if (warnCfg.warnAction === "ban" && (!m || m.bannable)) {
              await interaction.guild.members.ban(target.id, { reason: `Auto: reached ${total} warnings` });
              done = "banned";
            }
            if (done) {
              await interaction.followUp({ content: `🚨 ${target.tag} reached ${total} warnings and was automatically ${done}.` });
              await sendPublicModMessage(client, interaction.guild.id, `Auto-punish: ${warnCfg.warnAction}`, target, client.user, `Reached ${total} warnings`, { color: 0xff0000 });
            } else {
              await interaction.followUp({ content: `⚠️ ${target.tag} reached ${total} warnings, but I couldn't apply the automatic ${warnCfg.warnAction} (check my role/permissions).`, flags: 64 });
            }
          } catch (err) {
            console.error("Warn auto-punish failed:", err);
          }
        }
      }
    }

    // warnings
    if (cmd === "warnings") {
      const target = interaction.options.getUser("user") || interaction.user;
      const list = await warningsCollection.find({ guildId: interaction.guild.id, userId: target.id }).toArray();

      if (list.length === 0) {
        return interaction.reply({ content: `${target.tag} has no warnings.`, flags: 64 });
      }

      const lines = list.map((w, i) => `${i + 1}. ${w.reason} — by ${w.moderator} on ${w.time}`).join("\n");
      await interaction.reply({ content: `Warnings for ${target.tag}:\n${lines}`, flags: 64 });
    }

    // clear messages
    if (cmd === "clear") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageMessages)) {
        return interaction.reply({ content: "❌ You lack Manage Messages permission.", flags: 64 });
      }

      const amount = interaction.options.getInteger("amount");
      if (amount < 1 || amount > 100) {
        return interaction.reply({ content: "Amount must be between 1 and 100.", flags: 64 });
      }

      const channel = interaction.channel;
      const deleted = await channel.bulkDelete(amount, true).catch(() => null);

      await interaction.reply({ content: `🧹 Deleted ${deleted?.size || 0} messages.`, flags: 64 });
      await sendLog(client, `🧹 ${interaction.user.tag} deleted ${deleted?.size || 0} messages in #${channel.name}`);
    }
  } catch (err) {
    console.error("Interaction error:", err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: "⚠️ An error occurred while processing the command.", flags: 64 });
      } else {
        await interaction.reply({ content: "⚠️ An error occurred while processing the command.", flags: 64 });
      }
    } catch {}
    await sendLog(client, `⚠️ Command error: ${err.message}`);
  }
});

// === Auto-moderation ===
const INVITE_RE = /(discord\.gg|discord(?:app)?\.com\/invite)\/\S+/i;
const LINK_RE = /https?:\/\/\S+/i;
const blockedWordCache = new Map(); // raw setting text -> compiled RegExp (or null)

function getBlockedWordsRegex(raw) {
  if (!raw) return null;
  if (blockedWordCache.has(raw)) return blockedWordCache.get(raw);
  const words = raw.split(/[,\n]/).map(w => w.trim()).filter(Boolean).slice(0, 100);
  const re = words.length
    ? new RegExp(
        `(?<![\\p{L}\\p{N}])(?:${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\p{N}])`,
        "iu"
      )
    : null;
  if (blockedWordCache.size > 500) blockedWordCache.clear();
  blockedWordCache.set(raw, re);
  return re;
}

// Returns true if the message was removed
async function runAutomod(message, cfg) {
  if (!cfg.automodBlockInvites && !cfg.automodBlockLinks && !cfg.automodBlockedWords) return false;

  const member = message.member;
  if (
    !member ||
    member.permissions.has(PermissionFlagsBits.ManageMessages) ||
    member.permissions.has(PermissionFlagsBits.Administrator)
  ) return false;

  const text = message.content || "";
  let reason = null;
  if (cfg.automodBlockLinks && LINK_RE.test(text)) reason = "Links are not allowed here";
  else if ((cfg.automodBlockInvites || cfg.automodBlockLinks) && INVITE_RE.test(text)) reason = "Invite links are not allowed here";
  else {
    const re = getBlockedWordsRegex(cfg.automodBlockedWords);
    if (re && re.test(text)) reason = "That word is not allowed here";
  }
  if (!reason) return false;

  const myPerms = message.channel.permissionsFor(message.guild.members.me);
  if (!myPerms?.has(PermissionFlagsBits.ManageMessages)) return false;

  const deleted = await message.delete().then(() => true).catch(() => false);
  if (!deleted) return false;

  const notice = await message.channel.send({ content: `${message.author}, ${reason}.`, allowedMentions: { users: [message.author.id] } }).catch(() => null);
  if (notice) setTimeout(() => notice.delete().catch(() => {}), 5000);

  await sendPublicModMessage(client, message.guild.id, "Auto-mod: message removed", message.author, client.user, reason, { color: 0xE67E22 });
  return true;
}

// === Message handler (automod + XP + AI) ===
const xpCooldowns = new Map(); // "guildId:userId" -> last XP timestamp

client.on("messageCreate", async message => {
  try {
    const cfg = message.guild ? await getGuildConfig(message.guild.id) : null;

    // ===== AUTO-MOD =====
    if (cfg && !message.author.bot) {
      if (await runAutomod(message, cfg)) return;
    }

    // ===== XP GAIN (per-server toggle, amount and cooldown from the dashboard) =====
    if (cfg && cfg.xpEnabled && !message.author.bot) {
      const key = `${message.guild.id}:${message.author.id}`;
      const now = Date.now();
      if (now - (xpCooldowns.get(key) || 0) >= cfg.xpCooldownSeconds * 1000) {
        xpCooldowns.set(key, now);
        const result = await addXPToUser(message.guild.id, message.author.id, cfg.xpPerMessage);
        if (result.leveledUp) {
          await sendLevelUpMessage(client, message.author.id, result.newLevel, result.totalXP, message.guild.id);
        }
      }
    }

    // ===== AI REPLY LOGIC =====
    if (!shouldReply(message, cfg)) return;
    if (cfg && !cfg.aiEnabled) return; // DMs have no cfg and are always allowed

    const text = extractUserText(message);

    await message.channel.sendTyping();
    const reply = await callGroq(message.author.id, text, cfg?.aiPersonality);
    await sendLog(client, `💭 ${message.author.tag}: ${text}`);

    if (reply.length <= 2000) return message.reply(reply);

    const parts = reply.match(/[\s\S]{1,1900}/g) || [reply];
    for (const p of parts) await message.reply(p);
  } catch (err) {
    console.error("messageCreate error:", err);
    await sendLog(client, `⚠️ messageCreate error: ${err.message}`);
  }
});

// === Welcome / leave messages + auto-role ===
function formatTemplate(tpl, member) {
  return String(tpl)
    .replaceAll("{user}", `<@${member.id}>`)
    .replaceAll("{username}", member.user?.username ?? "Someone")
    .replaceAll("{server}", member.guild.name)
    .replaceAll("{count}", String(member.guild.memberCount));
}

client.on("guildMemberAdd", async member => {
  try {
    const cfg = await getGuildConfig(member.guild.id);

    if (cfg.autoRoleId) {
      const role = member.guild.roles.cache.get(cfg.autoRoleId);
      if (role && role.editable) {
        await member.roles.add(role, "Auto-role").catch(err => console.error("Auto-role failed:", err.message));
      }
    }

    if (cfg.welcomeEnabled && cfg.welcomeChannelId && !member.user.bot) {
      const channel = member.guild.channels.cache.get(cfg.welcomeChannelId);
      if (channel?.isTextBased()) {
        await channel.send({ content: formatTemplate(cfg.welcomeMessage, member), allowedMentions: { users: [member.id] } });
      }
    }
  } catch (err) {
    console.error("guildMemberAdd error:", err);
  }
});

client.on("guildMemberRemove", async member => {
  try {
    const cfg = await getGuildConfig(member.guild.id);
    if (!cfg.leaveEnabled || !cfg.leaveChannelId || member.user?.bot) return;
    const channel = member.guild.channels.cache.get(cfg.leaveChannelId);
    if (channel?.isTextBased()) {
      await channel.send({ content: formatTemplate(cfg.leaveMessage, member), allowedMentions: { parse: [] } });
    }
  } catch (err) {
    console.error("guildMemberRemove error:", err);
  }
});

// === Start bot ===
client.login(DISCORD_BOT_TOKEN).catch(err => {
  console.error("Failed to login:", err);
  process.exit(1);
});