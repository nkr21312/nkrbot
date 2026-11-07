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
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType
} from "discord.js";
import fetch from "node-fetch";
import express from "express";
import { AsyncLocalStorage } from "node:async_hooks";
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
const modActionsCollection = db.collection("modActions"); // feeds the dashboard + /userlogs
modActionsCollection.createIndex({ guildId: 1, targetId: 1, time: -1 }).catch(console.error);
const aiUsageCollection = db.collection("aiUsage"); // daily AI response counter per server
const countersCollection = db.collection("counters"); // per-server action ID counter
modActionsCollection.createIndex({ guildId: 1, caseId: 1 }, { unique: true, partialFilterExpression: { caseId: { $type: "number" } } }).catch(console.error);

// ===== Action IDs: every recorded action gets a short per-server number (#1, #2, ...) =====
// A command run keeps ONE "pending" ID in an async context so the DM, the reply, the warning
// record and the mod-log embed all show the SAME number.
const actionContext = new AsyncLocalStorage();

async function nextCaseId(guildId) {
  const r = await countersCollection.findOneAndUpdate(
    { _id: guildId },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" }
  );
  return (r?.value ?? r).seq;
}
async function peekActionId(guildId) {
  const s = actionContext.getStore();
  if (!s) return null;
  if (s.pending == null) s.pending = await nextCaseId(guildId);
  return s.pending;
}
async function takeActionId(guildId) {
  const s = actionContext.getStore();
  if (s && s.pending != null) {
    const id = s.pending;
    s.pending = null;
    return id;
  }
  return nextCaseId(guildId);
}
async function aidTag(guildId) {
  const id = await peekActionId(guildId);
  return id ? ` • Action ID **#${id}**` : "";
}

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
const DEFAULT_GUILD_CONFIG = { ...SETTINGS_DEFAULTS, commandRules: {} };

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
  partials: [Partials.Channel, Partials.Message]
});

// === Web server (Render keep-alive + dashboard) ===
const app = express();
app.set("trust proxy", 1); // Render sits behind a proxy; needed for secure cookies + rate limiting
app.disable("x-powered-by");

app.get("/", (req, res) => res.send("🧠 NKR.bot is alive!"));

app.use(
  "/dashboard",
  createDashboard({ client, db, mongoClient, getGuildConfig, setGuildConfig, getCommandNames: () => commands.map(c => c.name) })
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
    const caseId = await peekActionId(guild.id);
    const user = await client.users.fetch(userId);

    const embed = {
      color: 0x5865f2,
      title: `${action}`,
      fields: [
        { name: "Server", value: guildName, inline: true },
        { name: "Reason", value: reason || "No reason provided", inline: true }
      ],
      footer: { text: `User ID: ${userId}${caseId ? ` • Action ID #${caseId}` : ""}` },
      timestamp: new Date()
    };

    if (duration) {
      embed.fields.push({ name: "Duration", value: duration, inline: true });
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
  // 1) Always record to Mongo (dashboard, /userlogs), even if no mod-log channel is configured
  const caseId = await takeActionId(guildId);
  const recorded = modActionsCollection
    .insertOne({
      caseId,
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
    if (!channelId) return caseId; // this server hasn't set a mod-log channel yet

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return caseId;

    const embed = {
      color: extra.color || 0xff0000,
      title: `${action}`,
      fields: [
        { name: "User", value: `<@${target.id}> (${target.tag})`, inline: true },
        { name: "Moderator", value: `<@${moderator.id}>`, inline: true },
        { name: "Reason", value: reason || "No reason provided" }
      ],
      footer: { text: `User ID: ${target.id} • Action ID #${caseId}` },
      timestamp: new Date()
    };

    if (extra.duration) {
      embed.fields.push({ name: "Duration", value: extra.duration });
    }

    const sent = await channel.send({ embeds: [embed] });

    // Remember where the embed lives so /editreason can update it later
    await recorded;
    await modActionsCollection
      .updateOne({ guildId, caseId }, { $set: { logChannelId: channel.id, logMessageId: sent.id } })
      .catch(() => {});
  } catch (err) {
    console.error("Failed to send public mod message:", err);
  }
  return caseId;
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
        title: "Level Up!",
        description: `<@${userId}> reached **Level ${newLevel}**!`,
        thumbnail: user ? { url: user.displayAvatarURL() } : undefined,
        fields: [
          { name: "New Level", value: `${newLevel}`, inline: true },
          { name: "Total XP", value: `${totalXP}`, inline: true }
        ],
        footer: { text: `User ID: ${userId}` },
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
async function callGroq(userId, userText, systemPrompt, maxTokens) {
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
    max_tokens: maxTokens || 500
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

  // ===== NEW: full moderation history of one member in this server =====
  new SlashCommandBuilder()
    .setName("userlogs")
    .setDescription("Show every moderation log for a member in this server")
    .addUserOption(o => o.setName("user").setDescription("Member to look up").setRequired(true))
    .addIntegerOption(o => o.setName("page").setDescription("Page number (10 entries per page)").setMinValue(1))
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  // ===== NEW: delete one / all logs of a user ID =====
  new SlashCommandBuilder()
    .setName("clearlogs")
    .setDescription("Delete one or ALL moderation logs of a user ID in this server")
    .addStringOption(o => o.setName("userid").setDescription("User ID whose logs to delete").setRequired(true))
    .addIntegerOption(o =>
      o.setName("entry")
        .setDescription("Entry number from /userlogs to delete. Leave EMPTY to delete ALL logs + warnings of this user")
        .setMinValue(1)
    )
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // ===== NEW: change the reason of a logged action by its Action ID =====
  new SlashCommandBuilder()
    .setName("editreason")
    .setDescription("Change the reason of a logged action using its Action ID")
    .addIntegerOption(o => o.setName("id").setDescription("Action ID number (shown as #123 in logs and embeds)").setRequired(true).setMinValue(1))
    .addStringOption(o => o.setName("reason").setDescription("The new reason").setRequired(true).setMaxLength(500))
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

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
client.on("interactionCreate", interaction => {
  if (!interaction.isChatInputCommand()) return;
  actionContext.run({ pending: null }, () => handleInteraction(interaction));
});

async function handleInteraction(interaction) {

  const cmd = interaction.commandName;

  try {
    // ===== Per-server command rules from the dashboard (enabled + allowed channels) =====
    if (interaction.guild && cmd !== "dashboard") {
      const rule = (await getGuildConfig(interaction.guild.id)).commandRules?.[cmd];
      if (rule) {
        if (rule.enabled === false) {
          return interaction.reply({ content: `❌ /${cmd} is disabled in this server.`, flags: 64 });
        }
        const allowed = rule.channels || [];
        const parent = interaction.channel?.parentId; // threads inherit their parent channel's rule
        if (allowed.length && !allowed.includes(interaction.channelId) && !(parent && allowed.includes(parent))) {
          return interaction.reply({ content: `❌ /${cmd} can only be used in ${allowed.map(id => `<#${id}>`).join(", ")}.`, flags: 64 });
        }
      }
    }

    // AI ask
    if (cmd === "ask") {
      let aiPrompt, aiTokens;
      if (interaction.guild) {
        const cfg = await getGuildConfig(interaction.guild.id);
        if (!cfg.aiEnabled) {
          return interaction.reply({ content: "❌ AI replies are disabled in this server.", flags: 64 });
        }
        const access = await checkAiAccess({ guild: interaction.guild, userId: interaction.user.id, member: interaction.member, cfg });
        if (!access.ok) {
          return interaction.reply({ content: access.notice || "❌ You can't use the AI in this server.", flags: 64 });
        }
        aiPrompt = cfg.aiPersonality;
        aiTokens = cfg.aiMaxTokens;
      }

      const question = interaction.options.getString("question");
      await interaction.deferReply();

      const reply = await callGroq(interaction.user.id, question, aiPrompt, aiTokens);
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
            "**Moderation:** /kick /ban /softban /unban /mute /unmute /warn /warnings /userlogs /clearlogs /editreason /clear",
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
        title: `${user.username}'s Level Info`,
        footer: { text: `User ID: ${user.id}` },
        thumbnail: { url: user.displayAvatarURL() },
        fields: [
          { name: "Level", value: `${levelInfo.level}`, inline: true },
          { name: "Total XP", value: `${levelInfo.totalXP}`, inline: true },
          { name: "Progress", value: `${progressBar} ${progressPercent}%`, inline: false },
          { name: "XP in Level", value: `${levelInfo.xpInCurrentLevel}/${levelInfo.xpNeededForThisLevel}`, inline: true },
          { name: "XP to Next Level", value: `${levelInfo.xpNeededForThisLevel - levelInfo.xpInCurrentLevel}`, inline: true }
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
        const medal = `#${i + 1}`;
        description += `${medal} <@${users[i].userId}> - Level **${users[i].level}** (${users[i].totalXP} XP)\n`;
      }

      const embed = {
        color: 0xFFD700,
        title: "Leaderboard",
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

      await interaction.reply(`✅ Kicked ${target.tag} — ${reason}${await aidTag(interaction.guild.id)}`);
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

      await interaction.reply({ content: `✅ Banned ${target.tag}${await aidTag(interaction.guild.id)}`, flags: 64 });
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

      await interaction.editReply(`✅ Softbanned ${target.tag} — deleted ${days} day(s) of messages. They can rejoin.${await aidTag(interaction.guild.id)}`);
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
        await interaction.reply(`✅ Unbanned user with ID ${userId}${await aidTag(interaction.guild.id)}`);
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
      await interaction.reply(`🔇 ${target.tag} muted for ${minutes} minute(s).${await aidTag(interaction.guild.id)}`);

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
      await interaction.reply(`🔊 ${target.tag} has been unmuted.${await aidTag(interaction.guild.id)}`);
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
        caseId: await peekActionId(interaction.guild.id),
        time: new Date().toISOString()
      });

      await interaction.reply(`⚠️ Warned ${target.tag}: ${reason}${await aidTag(interaction.guild.id)}`);
      await sendLog(client, `⚠️ ${interaction.user.tag} warned ${target.tag}: ${reason}`);

      await sendModActionDM(client, interaction.guild, target.id, "Warning on server", reason);
      await sendPublicModMessage(client, interaction.guild.id, "User Warned", target, interaction.user, reason, { color: 0xFFA500 });

      // Auto-punishment once the warning threshold is reached (set in the dashboard)
      const esc = await checkWarnEscalation(interaction.guild, target);
      if (esc) {
        if (esc.done) {
          await interaction.followUp({ content: `🚨 ${target.tag} reached ${esc.total} warnings and was automatically ${esc.done}.${esc.caseId ? ` (Action ID **#${esc.caseId}**)` : ""}` });
        } else {
          await interaction.followUp({ content: `⚠️ ${target.tag} reached ${esc.total} warnings, but I couldn't apply the automatic ${esc.action} (check my role is above theirs and I have the permission).`, flags: 64 });
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

      const lines = list.map((w, i) => `${i + 1}. ${w.caseId ? `[#${w.caseId}] ` : ""}${w.reason} — by ${w.moderator} on ${w.time}`).join("\n");
      await interaction.reply({ content: `Warnings for ${target.tag}:\n${lines}`, flags: 64 });
    }

    // ===== NEW: userlogs =====
    if (cmd === "userlogs") {
      if (
        !interaction.memberPermissions.has(PermissionFlagsBits.ModerateMembers) &&
        !interaction.memberPermissions.has(PermissionFlagsBits.KickMembers)
      ) {
        return interaction.reply({ content: "❌ You need the Moderate Members permission to use this.", flags: 64 });
      }

      const user = interaction.options.getUser("user");
      const page = interaction.options.getInteger("page") ?? 1;
      const PAGE_SIZE = 10;
      const filter = { guildId: interaction.guild.id, targetId: user.id };

      const [total, entries, byAction, warnCount, member] = await Promise.all([
        modActionsCollection.countDocuments(filter),
        modActionsCollection.find(filter).sort({ time: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).toArray(),
        modActionsCollection.aggregate([{ $match: filter }, { $group: { _id: "$action", n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray(),
        warningsCollection.countDocuments({ guildId: interaction.guild.id, userId: user.id }),
        interaction.guild.members.fetch(user.id).catch(() => null)
      ]);

      if (total === 0 && warnCount === 0) {
        return interaction.reply({ content: `✅ No moderation records for **${user.tag}** (ID: ${user.id}) in this server.`, flags: 64 });
      }

      const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

      let description = entries.length
        ? entries.map((e, i) => {
            const unix = Math.floor(new Date(e.time).getTime() / 1000);
            const extra = e.duration ? ` • ${e.duration}` : "";
            const reason = String(e.reason || "No reason provided").slice(0, 120);
            return `**${(page - 1) * PAGE_SIZE + i + 1}.** ${e.caseId ? `\`#${e.caseId}\` ` : ""}<t:${unix}:f> • **${e.action}**${extra}\n└ by ${e.moderatorTag} — ${reason}${e.reasonEditedAt ? " (edited)" : ""}`;
          }).join("\n\n")
        : "No entries on this page.";
      if (description.length > 4000) description = description.slice(0, 3990) + "…";

      const summary = byAction.length
        ? byAction.map(a => `${a._id}: **${a.n}**`).join("\n").slice(0, 1000)
        : "—";

      const embed = {
        color: 0x5865f2,
        title: `Mod logs — ${user.tag}`,
        thumbnail: { url: user.displayAvatarURL() },
        description,
        fields: [
          { name: "Summary", value: summary },
          { name: "Warnings on record", value: String(warnCount), inline: true },
          { name: "Total actions", value: String(total), inline: true },
          { name: "In server", value: member ? "Yes" : "No", inline: true }
        ],
        footer: { text: `User ID: ${user.id} • Page ${Math.min(page, pages)}/${pages}` },
        timestamp: new Date()
      };

      await interaction.reply({ embeds: [embed], flags: 64 });
    }

    // ===== NEW: clearlogs =====
    if (cmd === "clearlogs") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: "❌ You need the Manage Server permission to delete logs.", flags: 64 });
      }

      const userId = interaction.options.getString("userid").trim();
      if (!/^\d{15,25}$/.test(userId)) {
        return interaction.reply({ content: "❌ That doesn't look like a valid user ID (numbers only).", flags: 64 });
      }

      const entryNum = interaction.options.getInteger("entry");
      const guildId = interaction.guild.id;
      const filter = { guildId, targetId: userId };

      // ---- delete ONE entry (number shown in /userlogs, newest = 1) ----
      if (entryNum) {
        const [doc] = await modActionsCollection.find(filter).sort({ time: -1 }).skip(entryNum - 1).limit(1).toArray();
        if (!doc) {
          return interaction.reply({ content: `❌ There is no entry #${entryNum} for ID ${userId}. Check the numbers in /userlogs.`, flags: 64 });
        }

        await modActionsCollection.deleteOne({ _id: doc._id });

        // If it was a /warn entry, remove the matching warning too so the warning count stays correct
        let warnRemoved = false;
        if (doc.action === "User Warned") {
          const t = new Date(doc.time).getTime();
          const w = await warningsCollection.findOne({
            guildId,
            userId,
            time: { $gte: new Date(t - 10000).toISOString(), $lte: new Date(t + 10000).toISOString() }
          });
          if (w) {
            await warningsCollection.deleteOne({ _id: w._id });
            warnRemoved = true;
          }
        }

        await interaction.reply({
          content: `🗑 Deleted log #${entryNum} (**${doc.action}**) for ID \`${userId}\`.${warnRemoved ? " The matching warning was removed too." : ""}`,
          flags: 64
        });
        await sendLog(client, `🗑 ${interaction.user.tag} deleted log #${entryNum} (${doc.action}) of ${userId} in ${interaction.guild.name}`);
        return;
      }

      // ---- delete EVERYTHING for this user (needs confirmation) ----
      const [logCount, warnCount] = await Promise.all([
        modActionsCollection.countDocuments(filter),
        warningsCollection.countDocuments({ guildId, userId })
      ]);
      if (logCount === 0 && warnCount === 0) {
        return interaction.reply({ content: `✅ Nothing to delete — no records for ID \`${userId}\` in this server.`, flags: 64 });
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("clearlogs_confirm").setLabel("Delete everything").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("clearlogs_cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
      );

      await interaction.reply({
        content: `⚠️ This will permanently delete **${logCount}** log entries and **${warnCount}** warnings for ID \`${userId}\` in this server. This cannot be undone.`,
        components: [row],
        flags: 64
      });
      const prompt = await interaction.fetchReply();

      try {
        const click = await prompt.awaitMessageComponent({
          componentType: ComponentType.Button,
          filter: i => i.user.id === interaction.user.id,
          time: 30000
        });

        if (click.customId === "clearlogs_confirm") {
          const [r1, r2] = await Promise.all([
            modActionsCollection.deleteMany(filter),
            warningsCollection.deleteMany({ guildId, userId })
          ]);
          await click.update({
            content: `🗑 Deleted **${r1.deletedCount}** log entries and **${r2.deletedCount}** warnings for ID \`${userId}\`.`,
            components: []
          });
          await sendLog(client, `🗑 ${interaction.user.tag} deleted ALL logs (${r1.deletedCount} entries, ${r2.deletedCount} warnings) of ${userId} in ${interaction.guild.name}`);
        } else {
          await click.update({ content: "Cancelled. Nothing was deleted.", components: [] });
        }
      } catch {
        await interaction.editReply({ content: "⏱ Timed out. Nothing was deleted.", components: [] }).catch(() => {});
      }
    }

    // ===== NEW: editreason =====
    if (cmd === "editreason") {
      if (
        !interaction.memberPermissions.has(PermissionFlagsBits.ModerateMembers) &&
        !interaction.memberPermissions.has(PermissionFlagsBits.KickMembers)
      ) {
        return interaction.reply({ content: "❌ You need the Moderate Members permission to use this.", flags: 64 });
      }

      const caseId = interaction.options.getInteger("id");
      const newReason = interaction.options.getString("reason").trim().slice(0, 500);
      const guildId = interaction.guild.id;

      const doc = await modActionsCollection.findOne({ guildId, caseId });
      if (!doc) {
        return interaction.reply({ content: `❌ No action with ID #${caseId} in this server.`, flags: 64 });
      }

      await modActionsCollection.updateOne(
        { _id: doc._id },
        {
          $set: { reason: newReason, reasonEditedBy: interaction.user.tag, reasonEditedAt: new Date() },
          $push: { reasonHistory: { reason: doc.reason, editedBy: interaction.user.tag, editedById: interaction.user.id, at: new Date() } }
        }
      );
      // Keep the warning record in sync (the /warnings list and threshold use it)
      await warningsCollection.updateMany({ guildId, caseId }, { $set: { reason: newReason } });

      // Update the original mod-log embed too
      let embedUpdated = false;
      if (doc.logChannelId && doc.logMessageId) {
        const ch = await client.channels.fetch(doc.logChannelId).catch(() => null);
        const msg = ch ? await ch.messages.fetch(doc.logMessageId).catch(() => null) : null;
        if (msg && msg.embeds[0]) {
          const emb = msg.embeds[0].toJSON();
          emb.fields = (emb.fields || []).filter(f => f.name !== "Reason edited" && f.name !== "✏️ Reason edited");
          const rf = emb.fields.find(f => f.name === "Reason" || f.name === "📝 Reason");
          if (rf) rf.value = newReason.slice(0, 1024);
          emb.fields.push({ name: "Reason edited", value: `by <@${interaction.user.id}> • <t:${Math.floor(Date.now() / 1000)}:R>` });
          embedUpdated = await msg.edit({ embeds: [emb] }).then(() => true).catch(() => false);
        }
      }

      await interaction.reply({
        content: `✅ Reason of action **#${caseId}** (${doc.action} — ${doc.targetTag}) updated.\n**Old:** ${String(doc.reason).slice(0, 200)}\n**New:** ${newReason}${embedUpdated ? "\nThe mod-log embed was updated too." : ""}\n*The DM already sent to the member can't be changed.*`,
        flags: 64
      });
      await sendLog(client, `✏️ ${interaction.user.tag} changed the reason of action #${caseId} in ${interaction.guild.name}`);
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
}

// === Warning threshold auto-punishment (used by /warn AND auto-mod) ===
async function checkWarnEscalation(guild, user) {
  const cfg = await getGuildConfig(guild.id);
  if (!cfg.warnThreshold || cfg.warnThreshold <= 0) return null;

  const total = await warningsCollection.countDocuments({ guildId: guild.id, userId: user.id });
  if (total === 0 || total % cfg.warnThreshold !== 0) return null;

  try {
    const m = await guild.members.fetch(user.id).catch(() => null);
    let done = null;

    if (m && cfg.warnAction === "mute" && m.moderatable) {
      await m.timeout(cfg.warnMuteMinutes * 60 * 1000, `Auto: reached ${total} warnings`);
      done = `muted for ${cfg.warnMuteMinutes} minute(s)`;
    } else if (m && cfg.warnAction === "kick" && m.kickable) {
      await m.kick(`Auto: reached ${total} warnings`);
      done = "kicked";
    } else if (cfg.warnAction === "ban" && (!m || m.bannable)) {
      await guild.members.ban(user.id, { reason: `Auto: reached ${total} warnings` });
      done = "banned";
    }

    let caseId = null;
    if (done) {
      caseId = await sendPublicModMessage(client, guild.id, `Auto-punish: ${cfg.warnAction}`, user, client.user, `Reached ${total} warnings`, { color: 0xff0000 });
    }
    return { total, done, action: cfg.warnAction, caseId };
  } catch (err) {
    console.error("Warn auto-punish failed:", err);
    return { total, done: null, action: cfg.warnAction };
  }
}

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

  // Optionally count this as a warning so the auto-punish threshold can kick in
  if (cfg.automodAddWarning) {
    await warningsCollection.insertOne({
      guildId: message.guild.id,
      userId: message.author.id,
      moderator: client.user.tag,
      reason: `Auto-mod: ${reason}`,
      caseId: await peekActionId(message.guild.id),
      time: new Date().toISOString()
    });
    await sendModActionDM(client, message.guild, message.author.id, "Warning on server", `Auto-mod: ${reason}`);
  }

  // Records the removal (and takes the pending ID the DM/warning above already showed)
  await sendPublicModMessage(client, message.guild.id, "Auto-mod: message removed", message.author, client.user, reason, { color: 0xE67E22 });

  if (cfg.automodAddWarning) {
    const esc = await checkWarnEscalation(message.guild, message.author);
    if (esc) {
      const msg = esc.done
        ? `🚨 ${message.author} reached ${esc.total} warnings and was automatically ${esc.done}.${esc.caseId ? ` (Action ID **#${esc.caseId}**)` : ""}`
        : `⚠️ ${message.author} reached ${esc.total} warnings, but I couldn't apply the automatic ${esc.action} (check my role is above theirs and I have the permission).`;
      await message.channel.send({ content: msg, allowedMentions: { users: [message.author.id] } }).catch(() => null);
    }
  }
  return true;
}

// === Helpers for dashboard ID lists ===
const idList = raw => new Set(String(raw || "").match(/\d{15,25}/g) || []);

// === AI access control (blocked users, allow-list, per-member limit, daily server cap) ===
const aiWindowUsage = new Map(); // "guildId:userId" -> [timestamps]

async function checkAiAccess({ guild, userId, member, cfg }) {
  // 1) Blocked users — nobody bypasses this, and they get no notice
  if (idList(cfg.aiBlockedUsers).has(userId)) return { ok: false, notice: null };

  // 2) Staff (Manage Server) skip the allow-list and all limits
  if (member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return { ok: true };

  // 3) Allow-list (users and/or role)
  const allowedUsers = idList(cfg.aiAllowedUsers);
  if (allowedUsers.size > 0 || cfg.aiAllowedRoleId) {
    const roleOk = cfg.aiAllowedRoleId && member?.roles?.cache?.has(cfg.aiAllowedRoleId);
    if (!allowedUsers.has(userId) && !roleOk) {
      return { ok: false, notice: "🔒 AI is limited to selected members in this server." };
    }
  }

  // 4) Per-member limit (sliding window)
  const key = `${guild.id}:${userId}`;
  const now = Date.now();
  let stamps = [];
  if (cfg.aiMaxMessagesPerUser > 0) {
    const windowMs = cfg.aiWindowMinutes * 60 * 1000;
    stamps = (aiWindowUsage.get(key) || []).filter(t => now - t < windowMs);
    if (stamps.length >= cfg.aiMaxMessagesPerUser) {
      aiWindowUsage.set(key, stamps);
      const mins = Math.max(1, Math.ceil((windowMs - (now - stamps[0])) / 60000));
      return { ok: false, notice: `⏳ You've used your ${cfg.aiMaxMessagesPerUser} AI message(s) for now. Try again in about ${mins} minute(s).` };
    }
  }

  // 5) Daily server-wide cap (stored in Mongo so it survives restarts)
  const day = new Date().toISOString().slice(0, 10);
  if (cfg.aiDailyServerCap > 0) {
    const usage = await aiUsageCollection.findOne({ guildId: guild.id, day });
    if ((usage?.count || 0) >= cfg.aiDailyServerCap) {
      return { ok: false, notice: "📅 This server's daily AI limit has been reached. It resets at 00:00 UTC." };
    }
  }

  // Allowed: record usage
  if (cfg.aiMaxMessagesPerUser > 0) {
    stamps.push(now);
    aiWindowUsage.set(key, stamps);
    if (aiWindowUsage.size > 5000) {
      for (const [k, v] of aiWindowUsage) if (!v.length || now - v[v.length - 1] > 24 * 3600 * 1000) aiWindowUsage.delete(k);
    }
  }
  if (cfg.aiDailyServerCap > 0) {
    await aiUsageCollection.updateOne({ guildId: guild.id, day }, { $inc: { count: 1 } }, { upsert: true });
  }
  return { ok: true };
}

// === Message stream logging (with attachment forwarding) ===
const MAX_FORWARD_BYTES = 10 * 1024 * 1024; // safe for every server boost level

function getMsgLogChannel(guild, cfg, sourceChannelId) {
  if (!cfg.msgLogEnabled || !cfg.msgLogChannelId) return null;
  if (sourceChannelId === cfg.msgLogChannelId) return null; // never log the log channel (would loop)
  if (idList(cfg.msgLogIgnoredChannels).has(sourceChannelId)) return null;
  const ch = guild?.channels?.cache?.get(cfg.msgLogChannelId);
  return ch && ch.isTextBased() ? ch : null;
}

async function logMessage(message, cfg) {
  try {
    if (message.author.bot && !cfg.msgLogBots) return;
    const channel = getMsgLogChannel(message.guild, cfg, message.channel.id);
    if (!channel) return;

    const atts = [...message.attachments.values()];
    const embed = {
      color: 0x2B2D31,
      author: { name: message.author.tag, icon_url: message.author.displayAvatarURL() },
      description: message.content ? message.content.slice(0, 4000) : (atts.length ? "*(attachment only)*" : "*(no text)*"),
      fields: [
        { name: "Channel", value: `<#${message.channel.id}>`, inline: true },
        { name: "Jump", value: `[Open message](${message.url})`, inline: true }
      ],
      footer: { text: `User ID: ${message.author.id} • Message ID: ${message.id}` },
      timestamp: message.createdAt
    };

    const payload = { embeds: [embed], allowedMentions: { parse: [] } };
    let uploadable = [];

    if (atts.length) {
      if (cfg.msgLogAttachments) {
        uploadable = atts.filter(a => a.size <= MAX_FORWARD_BYTES).slice(0, 10);
        const linkOnly = atts.filter(a => !uploadable.includes(a));
        if (linkOnly.length) {
          embed.fields.push({ name: "Too large to forward (links)", value: linkOnly.map(a => `[${a.name}](${a.url})`).join("\n").slice(0, 1000) });
        }
        if (uploadable.length) payload.files = uploadable.map(a => ({ attachment: a.url, name: a.name }));
      } else {
        embed.fields.push({ name: "Attachments", value: atts.map(a => a.name).join(", ").slice(0, 1000) });
      }
    }

    try {
      await channel.send(payload);
    } catch (err) {
      // Upload failed (size/permissions/network) — fall back to plain links so nothing is lost
      if (!payload.files) throw err;
      delete payload.files;
      embed.fields.push({ name: "Attachments (upload failed — links)", value: uploadable.map(a => `[${a.name}](${a.url})`).join("\n").slice(0, 1000) });
      await channel.send(payload);
    }
  } catch (err) {
    console.error("Message log failed:", err.message);
  }
}

client.on("messageUpdate", async (oldMsg, newMsg) => {
  try {
    if (!newMsg.guildId) return;
    const cfg = await getGuildConfig(newMsg.guildId);
    if (!cfg.msgLogEnabled || !cfg.msgLogEdits) return;

    if (newMsg.partial) newMsg = await newMsg.fetch().catch(() => null);
    if (!newMsg || !newMsg.author) return;
    if (newMsg.author.bot && !cfg.msgLogBots) return;
    if (!oldMsg.partial && oldMsg.content === newMsg.content) return; // embed/link-preview update, not a real edit

    const channel = getMsgLogChannel(newMsg.guild, cfg, newMsg.channelId);
    if (!channel) return;

    await channel.send({
      embeds: [{
        color: 0xF1C40F,
        title: "Message edited",
        author: { name: newMsg.author.tag, icon_url: newMsg.author.displayAvatarURL() },
        fields: [
          { name: "Before", value: oldMsg.partial ? "*(not cached)*" : (oldMsg.content || "*(empty)*").slice(0, 1000) },
          { name: "After", value: (newMsg.content || "*(empty)*").slice(0, 1000) },
          { name: "Channel", value: `<#${newMsg.channelId}>`, inline: true },
          { name: "Jump", value: `[Open message](${newMsg.url})`, inline: true }
        ],
        footer: { text: `User ID: ${newMsg.author.id} • Message ID: ${newMsg.id}` },
        timestamp: new Date()
      }],
      allowedMentions: { parse: [] }
    });
  } catch (err) {
    console.error("messageUpdate log failed:", err.message);
  }
});

client.on("messageDelete", async msg => {
  try {
    if (!msg.guildId) return;
    const cfg = await getGuildConfig(msg.guildId);
    if (!cfg.msgLogEnabled || !cfg.msgLogDeletes) return;
    if (msg.author?.bot && !cfg.msgLogBots) return;

    const guild = client.guilds.cache.get(msg.guildId);
    const channel = getMsgLogChannel(guild, cfg, msg.channelId);
    if (!channel) return;

    const attNames = msg.attachments?.size ? [...msg.attachments.values()].map(a => a.name).join(", ") : null;
    const fields = [
      { name: "Author", value: msg.author ? `<@${msg.author.id}> (${msg.author.tag})` : "Unknown (message was not cached)", inline: true },
      { name: "Channel", value: `<#${msg.channelId}>`, inline: true }
    ];
    if (attNames) fields.push({ name: "Attachments", value: attNames.slice(0, 1000) });

    await channel.send({
      embeds: [{
        color: 0xE74C3C,
        title: "Message deleted",
        description: msg.partial ? "*(content not cached)*" : (msg.content ? msg.content.slice(0, 4000) : "*(no text)*"),
        fields,
        footer: { text: msg.author ? `User ID: ${msg.author.id} • Message ID: ${msg.id}` : `Message ID: ${msg.id}` },
        timestamp: new Date()
      }],
      allowedMentions: { parse: [] }
    });
  } catch (err) {
    console.error("messageDelete log failed:", err.message);
  }
});

client.on("messageDeleteBulk", async (messages, ch) => {
  try {
    if (!ch.guildId) return;
    const cfg = await getGuildConfig(ch.guildId);
    if (!cfg.msgLogEnabled || !cfg.msgLogDeletes) return;
    const channel = getMsgLogChannel(ch.guild, cfg, ch.id);
    if (!channel) return;
    await channel.send({
      embeds: [{ color: 0xE74C3C, title: "Bulk delete", description: `**${messages.size}** messages were deleted in <#${ch.id}>.`, timestamp: new Date() }]
    });
  } catch (err) {
    console.error("messageDeleteBulk log failed:", err.message);
  }
});

// === Message handler (automod + XP + AI) ===
const xpCooldowns = new Map(); // "guildId:userId" -> last XP timestamp

client.on("messageCreate", async message => {
  try {
    const cfg = message.guild ? await getGuildConfig(message.guild.id) : null;

    // ===== MESSAGE LOGGING (before auto-mod so removed messages + attachments are still captured) =====
    if (cfg && cfg.msgLogEnabled) await logMessage(message, cfg);

    // ===== AUTO-MOD =====
    if (cfg && !message.author.bot) {
      if (await actionContext.run({ pending: null }, () => runAutomod(message, cfg))) return;
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

    // Per-server AI access rules + limits (blocked users, allow-list, per-member limit, daily cap)
    if (cfg) {
      const access = await checkAiAccess({ guild: message.guild, userId: message.author.id, member: message.member, cfg });
      if (!access.ok) {
        if (access.notice && cfg.aiLimitNotice) await message.reply(access.notice).catch(() => {});
        return;
      }
    }

    const text = extractUserText(message);

    await message.channel.sendTyping();
    const reply = await callGroq(message.author.id, text, cfg?.aiPersonality, cfg?.aiMaxTokens);
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