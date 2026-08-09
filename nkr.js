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



// === Config / tokens ===
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
// const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY; // No credit on free plan, switched to Groq
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID; // optional, set in Render

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
// NEW: per-guild config (e.g. where global mod messages should be posted)
const guildConfigCollection = db.collection("guildConfig");

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
    userData = {
      guildId,
      userId,
      level: 1,
      totalXP: 0
    };
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
    {
      $set: {
        level: userData.level,
        totalXP: userData.totalXP
      }
    },
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
      xpForNextLevel: getXPForLevel(2)
    };
  }

  const xpNeededForCurrentLevel = getTotalXPForLevel(userData.level);
  const xpNeededForNextLevel = getTotalXPForLevel(userData.level + 1);

  const xpInCurrentLevel =
    userData.totalXP - xpNeededForCurrentLevel;

  const xpNeededForThisLevel =
    xpNeededForNextLevel - xpNeededForCurrentLevel;

  return {
    level: userData.level,
    totalXP: userData.totalXP,
    xpInCurrentLevel,
    xpNeededForThisLevel,
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

// ===== NEW: Per-guild mod-log channel config =====
// Simple in-memory cache so we don't hit Mongo on every single mod action
const modLogChannelCache = new Map();

async function setModLogChannel(guildId, channelId) {
  await guildConfigCollection.updateOne(
    { guildId },
    { $set: { guildId, modLogChannelId: channelId } },
    { upsert: true }
  );
  modLogChannelCache.set(guildId, channelId);
}

async function getModLogChannelId(guildId) {
  if (modLogChannelCache.has(guildId)) {
    return modLogChannelCache.get(guildId);
  }
  const doc = await guildConfigCollection.findOne({ guildId });
  const channelId = doc?.modLogChannelId || null;
  modLogChannelCache.set(guildId, channelId);
  return channelId;
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

// Send mod action DM to user (now as an embed)
async function sendModActionDM(client, guildName, userId, action, reason, duration = null) {
  try {
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

// Send global/public mod message to THIS guild's configured mod-log channel.
// Works for any server that has run /setmodlog — no longer hardcoded to one server.
async function sendPublicModMessage(client, guildId, action, target, moderator, reason, extra = {}) {
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
    if (!GROUP_LEVEL_UP_CHANNEL_ID) return;
    const channel = await client.channels.fetch(GROUP_LEVEL_UP_CHANNEL_ID);
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
async function callGroq(userId, userText) {
  if (!GROQ_API_KEY) throw new Error("Missing Groq key");
  if (!memory.has(userId)) memory.set(userId, []);
  const convo = memory.get(userId);
  convo.push({ role: "user", content: userText });
  if (convo.length > 10) convo.splice(0, convo.length - 10);

  const body = {
    model: "llama-3.3-70b-versatile", // Groq's flagship free-tier model
    messages: [
      { role: "system", content: "You are a friendly Discord assistant. Keep answers concise." },
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
    return "⚠️ I'm having trouble reaching the AI service right now. Try again in a bit!";
  }
  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content?.trim() || "I couldn't think of a reply.";
  convo.push({ role: "assistant", content: reply });
  return reply;
}

// === Helper: message filtering ===
function shouldReply(message) {
  if (message.author.bot) return false;

  // Allow DMs (works for both servers)
  if (message.channel?.type === 1) return true;

  // Detect AI trigger
  const isAIMessage =
    message.content.trim().startsWith("!") ||
    message.mentions?.has(client.user);

  // Ignore normal messages
  if (!isAIMessage) return false;

  // ===== SERVER-SPECIFIC AI RESTRICTIONS =====
  // For GROUP SERVER: AI only in specific channel
  if (message.guild?.id === GROUP_SERVER_ID) {
    if (message.channel.id !== GROUP_AI_CHANNEL_ID) {
      return false;
    }
  }
  // For NKR SERVER: AI works in all channels (no restriction)
  // (no else needed - just allow it)

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
    .addUserOption(o => o.setName("user").setDescription("User to check (optional)")),
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Show top 10 users by level"),

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

  // ===== NEW: set the channel for global mod messages (per server) =====
  new SlashCommandBuilder()
    .setName("setmodlog")
    .setDescription("Set the channel where global mod action messages are posted (this server only)")
    .addChannelOption(o =>
      o.setName("channel")
        .setDescription("The text channel to post mod actions in")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
];

// === Register slash commands ===
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const rest = new REST().setToken(DISCORD_BOT_TOKEN);

  try {
    // Separate leveling commands (guild-based, GROUP SERVER ONLY)
    const levelingCommands = commands.filter(cmd =>
      ["level", "leaderboard"].includes(cmd.name)
    ).map(cmd => cmd.toJSON());

    // All other commands (global)
    const otherCommands = commands.filter(cmd =>
      !["level", "leaderboard"].includes(cmd.name)
    ).map(cmd => cmd.toJSON());

    // Register leveling commands to GROUP SERVER only
    if (GROUP_SERVER_ID) {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, GROUP_SERVER_ID),
        { body: levelingCommands }
      );
      console.log("✅ Leveling commands registered to GROUP SERVER!");
    }

    // Register global commands (moderation + AI + setmodlog)
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: otherCommands }
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
      const question = interaction.options.getString("question");
      await interaction.deferReply();
      const reply = await callGroq(interaction.user.id, question);
      await interaction.editReply(reply.slice(0, 2000));
      await sendLog(client, `💬 /ask by ${interaction.user.tag}: ${question}`);
    }

    // help
    if (cmd === "help") {
      await interaction.reply({
        embeds: [{
          title: "NKR.bot Help",
          description: "**/ask** • Ask the AI\n**/donate** • Support\n**/level** • Check your level (Group Server)\n**/leaderboard** • See top users (Group Server)\n**/setmodlog** • Set this server's mod-log channel (Manage Server)\n\n**Moderation:** /kick /ban /mute /warn /warnings /clear",
          color: 0x5865f2
        }],
        ephemeral: true
      });
    }

    // donate
    if (cmd === "donate") {
      await interaction.reply({ content: "Support: https://ko-fi.com/yourlink", flags: 64 });
    }

    // ===== NEW: setmodlog =====
    if (cmd === "setmodlog") {
      // setDefaultMemberPermissions already restricts this at the Discord UI level,
      // but we double-check server-side in case permissions were overridden.
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

    // ===== LEVELING COMMANDS (GROUP SERVER ONLY) =====

    // level - Check user level
    if (cmd === "level") {
      if (interaction.guild.id !== GROUP_SERVER_ID) {
        return interaction.reply({ content: "❌ This command only works in the Group Server!", flags: 64 });
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

    // leaderboard - Show top users
    if (cmd === "leaderboard") {
      if (interaction.guild.id !== GROUP_SERVER_ID) {
        return interaction.reply({ content: "❌ This command only works in the Group Server!", flags: 64 });
      }

      const users = await getLeaderboard(interaction.guild.id, 10);

      if (users.length === 0) {
        return interaction.reply({ content: "No users have leveled up yet!", flags: 64 });
      }

      let description = "";
      for (let i = 0; i < users.length; i++) {
        const user = await client.users.fetch(users[i].userId).catch(() => null);
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`;
        description += `${medal} <@${users[i].userId}> - Level **${users[i].level}** (${users[i].totalXP} XP)\n`;
      }

      const embed = {
        color: 0xFFD700,
        title: "🏆 Leaderboard",
        description: description,
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

      // Send DM BEFORE kick
      await sendModActionDM(client, interaction.guild.name, target.id, "Kicked from server", reason);

      await member.kick(reason);

      await interaction.reply(`✅ Kicked ${target.tag} — ${reason}`);
      await sendLog(client, `🔨 ${interaction.user.tag} kicked ${target.tag} — ${reason}`);

      // Send global mod message to THIS server's configured channel
      await sendPublicModMessage(client, interaction.guild.id, "User Kicked", target, interaction.user, reason, { color: 0xFFA500 });
    }

    // ban
    if (cmd === "ban") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.BanMembers)) {
        return interaction.reply({ content: "❌ You lack Ban Members permission.", flags: 64 });
      }
      const target = interaction.options.getUser("target");
      const reason = interaction.options.getString("reason") || "No reason provided";

      // Send DM BEFORE ban
      await sendModActionDM(client, interaction.guild.name, target.id, "Banned from server", reason);

      await interaction.guild.members.ban(target.id, { reason }).catch(err => { throw err; });

      await interaction.reply({ content: `✅ Banned ${target.tag}`, flags: 64 });
      await sendLog(client, `🔨 ${interaction.user.tag} banned ${target.tag} — ${reason}`);

      // Send global mod message to THIS server's configured channel
      await sendPublicModMessage(client, interaction.guild.id, "User Banned", target, interaction.user, reason, { color: 0xff0000 });
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

        // Send DM to user (fixed: was referencing undefined target/reason)
        await sendModActionDM(client, interaction.guild.name, userId, "Unbanned from server", "Unban");

        // Send global mod message to THIS server's configured channel
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

      await member.timeout(minutes * 60 * 1000, `Muted by ${interaction.user.tag}`).catch(e => { throw e; });
      await interaction.reply(`🔇 ${target.tag} muted for ${minutes} minute(s).`);

      // Send DM to user
      await sendModActionDM(client, interaction.guild.name, target.id, "Muted on server", "Timeout applied", `${minutes} minute(s)`);

      // Send global mod message to THIS server's configured channel
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

      await member.timeout(null, `Unmuted by ${interaction.user.tag}`).catch(e => { throw e; });
      await interaction.reply(`🔊 ${target.tag} has been unmuted.`);
      await sendLog(client, `🔊 ${interaction.user.tag} unmuted ${target.tag}`);

      // Send DM to user (fixed: was referencing undefined reason)
      await sendModActionDM(client, interaction.guild.name, target.id, "Unmuted from server", "Timeout removed");

      // Send global mod message to THIS server's configured channel
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

      // Send DM to user
      await sendModActionDM(client, interaction.guild.name, target.id, "Warning on server", reason);

      // Send global mod message to THIS server's configured channel
      await sendPublicModMessage(client, interaction.guild.id, "User Warned", target, interaction.user, reason, { color: 0xFFA500 });
    }

    // warnings
    if (cmd === "warnings") {
      const target = interaction.options.getUser("user") || interaction.user;
      const list = await warningsCollection.find({guildId: interaction.guild.id,userId: target.id}).toArray();
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

// === Message handler (AI via !chat or mention + XP gain) ===
client.on("messageCreate", async message => {
  try {
    // ===== XP GAIN (GROUP SERVER ONLY) =====
    if (!message.author.bot && message.guild && message.guild.id === GROUP_SERVER_ID) {
      const result = await addXPToUser(message.guild.id, message.author.id);

      // Notify user on level up
      if (result.leveledUp) {
        await sendLevelUpMessage(client, message.author.id, result.newLevel, result.totalXP, message.guild.id);
      }
    }

    // ===== AI REPLY LOGIC (Works in both servers, but restricted in GROUP SERVER) =====
    if (!shouldReply(message)) return;

    const text = extractUserText(message);
    await message.channel.sendTyping();
    const reply = await callGroq(message.author.id, text);
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