// bot.js - Improved version with guild-specific commands and enhanced moderation
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
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const GUILD_ID = process.env.GUILD_ID; // Main server (no XP)
const GENERAL_CHANNEL_ID = process.env.GENERAL_CHANNEL_ID;
const LEVEL_UP_CHANNEL_ID = process.env.LEVEL_UP_CHANNEL_ID;
process.env.GENERAL_CHANNEL_ID = GENERAL_CHANNEL_ID;

if (!DISCORD_BOT_TOKEN) {
  console.error("Missing DISCORD_BOT_TOKEN in environment. Exiting.");
  process.exit(1);
}

// === Server Configuration ===
const AI_SERVER_ID = "1155780893311520788"; // Secondary server (with XP)
const MAIN_SERVER_ID = GUILD_ID; // Main server (no XP)

const ALLOWED_AI_CHANNELS = ["1169991875709636628"];
const DISABLED_LEVELING_GUILDS = [MAIN_SERVER_ID]; // Disable XP in main server

// === Moderator Role Configuration ===
// No manual config needed - checks user's actual Discord permissions

// === Leveling System Config ===
const XP_PER_MESSAGE = 10;
const LEVEL_MULTIPLIER = 1.2;
const LEVEL_FILE = path.resolve("./levels.json");

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

// Load leveling data
async function loadLevels() {
  try {
    const raw = await fs.readFile(LEVEL_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// Save leveling data
async function saveLevels(obj) {
  await fs.writeFile(LEVEL_FILE, JSON.stringify(obj, null, 2), "utf8");
}

// Add XP to user and check for level up
async function addXPToUser(guildId, userId, xpAmount = XP_PER_MESSAGE) {
  const levels = await loadLevels();
  
  if (!levels[guildId]) levels[guildId] = {};
  if (!levels[guildId][userId]) {
    levels[guildId][userId] = { level: 1, totalXP: 0 };
  }
  
  const userData = levels[guildId][userId];
  const oldLevel = userData.level;
  
  userData.totalXP += xpAmount;
  
  let newLevel = 1;
  while (getTotalXPForLevel(newLevel + 1) <= userData.totalXP) {
    newLevel++;
  }
  
  userData.level = newLevel;
  await saveLevels(levels);
  
  return {
    xpAdded: xpAmount,
    newLevel: newLevel,
    oldLevel: oldLevel,
    totalXP: userData.totalXP,
    leveledUp: newLevel > oldLevel
  };
}

// Get user level info
async function getUserLevelInfo(guildId, userId) {
  const levels = await loadLevels();
  if (!levels[guildId] || !levels[guildId][userId]) {
    return { level: 1, totalXP: 0, xpForNextLevel: getXPForLevel(2) };
  }
  
  const userData = levels[guildId][userId];
  const xpNeededForCurrentLevel = getTotalXPForLevel(userData.level);
  const xpNeededForNextLevel = getTotalXPForLevel(userData.level + 1);
  const xpInCurrentLevel = userData.totalXP - xpNeededForCurrentLevel;
  const xpNeededForThisLevel = xpNeededForNextLevel - xpNeededForCurrentLevel;
  
  return {
    level: userData.level,
    totalXP: userData.totalXP,
    xpInCurrentLevel: xpInCurrentLevel,
    xpNeededForThisLevel: xpNeededForThisLevel,
    xpForNextLevel: xpNeededForNextLevel
  };
}

// Get leaderboard
async function getLeaderboard(guildId, limit = 10) {
  const levels = await loadLevels();
  if (!levels[guildId]) return [];
  
  const users = Object.entries(levels[guildId])
    .map(([userId, data]) => ({
      userId,
      level: data.level,
      totalXP: data.totalXP
    }))
    .sort((a, b) => {
      if (b.level !== a.level) return b.level - a.level;
      return b.totalXP - a.totalXP;
    })
    .slice(0, limit);
  
  return users;
}

// === Moderation Helper Functions ===

// Check if user is a moderator (checks actual Discord permissions)
function isModerator(member) {
  // Check if user has moderation permissions
  if (member.permissions.has(PermissionFlagsBits.ModerateMembers)) return true;
  if (member.permissions.has(PermissionFlagsBits.KickMembers)) return true;
  if (member.permissions.has(PermissionFlagsBits.BanMembers)) return true;
  if (member.permissions.has(PermissionFlagsBits.ManageMessages)) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  
  return false;
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

// === Warnings persistence ===
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

async function sendPublicModMessage(client, action, target, moderator, reason, extra = {}) {
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

  if (extra.duration)
    embed.fields.push({ name: "⏱ Duration", value: extra.duration });

  await sendToGeneral(client, embed);
}

async function sendToGeneral(client, embed) {
  try {
    const channel = await client.channels.fetch(GENERAL_CHANNEL_ID);
    if (channel && channel.isTextBased()) {
      await channel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error("Failed to send to general:", err);
  }
}

async function sendLevelUpMessage(client, userId, newLevel, totalXP, guildId) {
  try {
    const channel = await client.channels.fetch(LEVEL_UP_CHANNEL_ID);
    if (channel && channel.isTextBased()) {
      const user = await client.users.fetch(userId);
      const embed = {
        color: 0x00AA00,
        title: "🎉 Level Up!",
        description: `<@${userId}> reached **Level ${newLevel}**!`,
        fields: [{ name: "Total XP", value: `${totalXP}`, inline: true }],
        timestamp: new Date()
      };
      await channel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error("Failed to send level-up message:", err);
  }
}

async function sendLog(client, message) {
  try {
    if (!LOG_CHANNEL_ID) return;
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (channel && channel.isTextBased()) {
      await channel.send(message);
    }
  } catch (err) {
    console.error("Failed to send log:", err);
  }
}

// === AI / Message utilities ===
function shouldReply(message) {
  if (message.author.bot) return false;
  if (!message.guild) return false;
  
  // Only reply in allowed AI channels
  if (!ALLOWED_AI_CHANNELS.includes(message.channelId)) return false;
  
  // Respond to mentions or !chat prefix
  if (message.mentions.has(client.user)) return true;
  if (message.content.startsWith("!chat")) return true;
  
  return false;
}

function extractUserText(message) {
  let text = message.content;
  if (text.startsWith("!chat ")) text = text.slice(6);
  text = text.replace(/<@!?\d+>/g, "").trim();
  return text;
}

async function callOpenRouter(userId, text) {
  const response = await fetch("https://openrouter.io/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "meta-llama/llama-2-70b-chat",
      messages: [{ role: "user", content: text }],
      max_tokens: 500
    })
  });

  const data = await response.json();
  if (data.choices && data.choices[0]?.message?.content) {
    return data.choices[0].message.content;
  }
  return "Sorry, I couldn't generate a response.";
}

// === Register slash commands ===
client.on("ready", async () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  
  const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);
  
  try {
    // GLOBAL COMMANDS (available in all servers)
    const globalCommands = [
      new SlashCommandBuilder()
        .setName("kick")
        .setDescription("Kick a user from the server")
        .addUserOption(opt => opt.setName("target").setDescription("User to kick").setRequired(true))
        .addStringOption(opt => opt.setName("reason").setDescription("Reason for kick")),
      
      new SlashCommandBuilder()
        .setName("ban")
        .setDescription("Ban a user from the server")
        .addUserOption(opt => opt.setName("target").setDescription("User to ban").setRequired(true))
        .addStringOption(opt => opt.setName("reason").setDescription("Reason for ban")),
      
      new SlashCommandBuilder()
        .setName("unban")
        .setDescription("Unban a user")
        .addStringOption(opt => opt.setName("userid").setDescription("User ID to unban").setRequired(true)),
      
      new SlashCommandBuilder()
        .setName("mute")
        .setDescription("Mute a user (timeout)")
        .addUserOption(opt => opt.setName("target").setDescription("User to mute").setRequired(true))
        .addIntegerOption(opt => opt.setName("minutes").setDescription("Duration in minutes").setRequired(true)),
      
      new SlashCommandBuilder()
        .setName("unmute")
        .setDescription("Unmute a user (remove timeout)")
        .addUserOption(opt => opt.setName("target").setDescription("User to unmute").setRequired(true)),
      
      new SlashCommandBuilder()
        .setName("warn")
        .setDescription("Warn a user")
        .addUserOption(opt => opt.setName("target").setDescription("User to warn").setRequired(true))
        .addStringOption(opt => opt.setName("reason").setDescription("Reason for warning")),
      
      new SlashCommandBuilder()
        .setName("warnings")
        .setDescription("Check warnings for a user")
        .addUserOption(opt => opt.setName("user").setDescription("User to check warnings for")),
      
      new SlashCommandBuilder()
        .setName("clear")
        .setDescription("Clear messages from a channel")
        .addIntegerOption(opt => opt.setName("amount").setDescription("Number of messages to delete (1-100)").setRequired(true))
    ];

    // XP/LEVELING COMMANDS (only in secondary server)
    const xpCommands = [
      new SlashCommandBuilder()
        .setName("level")
        .setDescription("Check your current level and XP")
        .addUserOption(opt => opt.setName("user").setDescription("User to check")),
      
      new SlashCommandBuilder()
        .setName("leaderboard")
        .setDescription("View the top 10 users by level")
    ];

    // Register global commands
    console.log("📋 Registering global commands...");
    await rest.put(Routes.applicationCommands(client.user.id), { body: globalCommands });
    console.log(`✅ Registered ${globalCommands.length} global commands`);

    // Register guild-specific XP commands (only in secondary server)
    console.log(`📋 Registering XP commands in server ${AI_SERVER_ID}...`);
    await rest.put(Routes.applicationGuildCommands(client.user.id, AI_SERVER_ID), { body: xpCommands });
    console.log(`✅ Registered ${xpCommands.length} XP commands in secondary server`);

  } catch (err) {
    console.error("Failed to register commands:", err);
  }
});

// === Slash command handler ===
client.on("interactionCreate", async interaction => {
  if (!interaction.isCommand()) return;

  const cmd = interaction.commandName;

  try {
    // === MODERATION COMMANDS (Global) ===

    if (cmd === "kick") {
      const member = interaction.member;
      if (!isModerator(member)) {
        return interaction.reply({ 
          content: "❌ You need ban/kick permissions to use this command.", 
          flags: 64 
        });
      }

      const target = interaction.options.getUser("target");
      const reason = interaction.options.getString("reason") || "No reason provided";
      const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);

      if (!targetMember) {
        return interaction.reply({ 
          content: "❌ Member not found.", 
          flags: 64 
        });
      }

      if (!targetMember.kickable) {
        return interaction.reply({ 
          content: "❌ I cannot kick that user (insufficient permissions).", 
          flags: 64 
        });
      }

      await targetMember.kick(reason);
      await interaction.reply({ 
        content: `✅ Kicked ${target.tag} — ${reason}`,
        flags: 64 
      });
      await sendLog(client, `🔨 ${interaction.user.tag} kicked ${target.tag} — ${reason}`);
      await sendPublicModMessage(
        client,
        "User Kicked",
        target,
        interaction.user,
        reason,
        { color: 0xFFA500 }
      );
    }

    if (cmd === "ban") {
      const member = interaction.member;
      if (!isModerator(member)) {
        return interaction.reply({ 
          content: "❌ You need ban/kick permissions to use this command.", 
          flags: 64 
        });
      }

      const target = interaction.options.getUser("target");
      const reason = interaction.options.getString("reason") || "No reason provided";

      try {
        await interaction.guild.members.ban(target.id, { reason });
        await interaction.reply({ 
          content: `✅ Banned ${target.tag}`,
          flags: 64 
        });
        await sendLog(client, `🔨 ${interaction.user.tag} banned ${target.tag} — ${reason}`);
        await sendPublicModMessage(
          client,
          "User Banned",
          target,
          interaction.user,
          reason,
          { color: 0xff0000 }
        );
      } catch (err) {
        await interaction.reply({ 
          content: "❌ Failed to ban user. They may already be banned or I lack permissions.", 
          flags: 64 
        });
      }
    }

    if (cmd === "unban") {
      const member = interaction.member;
      if (!isModerator(member)) {
        return interaction.reply({ 
          content: "❌ You need ban/kick permissions to use this command.", 
          flags: 64 
        });
      }

      const userId = interaction.options.getString("userid");

      try {
        await interaction.guild.members.unban(userId);
        await interaction.reply({ 
          content: `✅ Unbanned user with ID ${userId}`,
          flags: 64 
        });
        await sendLog(client, `♻️ ${interaction.user.tag} unbanned ${userId}`);
        await sendPublicModMessage(
          client,
          "User Unbanned",
          { id: userId, tag: `ID:${userId}` },
          interaction.user,
          "Unban",
          { color: 0x2ECC71 }
        );
      } catch (err) {
        await interaction.reply({ 
          content: "❌ Failed to unban. Check the user ID.", 
          flags: 64 
        });
      }
    }

    if (cmd === "mute") {
      const member = interaction.member;
      if (!isModerator(member)) {
        return interaction.reply({ 
          content: "❌ You need moderator permissions to use this command.", 
          flags: 64 
        });
      }

      const target = interaction.options.getUser("target");
      const minutes = interaction.options.getInteger("minutes");
      const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);

      if (!targetMember) {
        return interaction.reply({ 
          content: "❌ Member not found.", 
          flags: 64 
        });
      }

      try {
        await targetMember.timeout(minutes * 60 * 1000, `Muted by ${interaction.user.tag}`);
        await interaction.reply({ 
          content: `🔇 ${target.tag} muted for ${minutes} minute(s).`,
          flags: 64 
        });
        await sendLog(client, `🔇 ${interaction.user.tag} muted ${target.tag} for ${minutes} minute(s)`);
        await sendPublicModMessage(
          client,
          "User Muted",
          target,
          interaction.user,
          "Timeout",
          { duration: `${minutes} minute(s)`, color: 0xFFD700 }
        );
      } catch (err) {
        await interaction.reply({ 
          content: "❌ Failed to mute user.", 
          flags: 64 
        });
      }
    }

    if (cmd === "unmute") {
      const member = interaction.member;
      if (!isModerator(member)) {
        return interaction.reply({ 
          content: "❌ You need moderator permissions to use this command.", 
          flags: 64 
        });
      }

      const target = interaction.options.getUser("target");
      const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);

      if (!targetMember) {
        return interaction.reply({ 
          content: "❌ Member not found.", 
          flags: 64 
        });
      }

      try {
        await targetMember.timeout(null, `Unmuted by ${interaction.user.tag}`);
        await interaction.reply({ 
          content: `🔊 ${target.tag} has been unmuted.`,
          flags: 64 
        });
        await sendLog(client, `🔊 ${interaction.user.tag} unmuted ${target.tag}`);
        await sendPublicModMessage(
          client,
          "User Unmuted",
          target,
          interaction.user,
          "Timeout removed",
          { color: 0x2ECC71 }
        );
      } catch (err) {
        await interaction.reply({ 
          content: "❌ Failed to unmute user.", 
          flags: 64 
        });
      }
    }

    if (cmd === "warn") {
      const member = interaction.member;
      if (!isModerator(member)) {
        return interaction.reply({ 
          content: "❌ You need moderator permissions to use this command.", 
          flags: 64 
        });
      }

      const target = interaction.options.getUser("target");
      const reason = interaction.options.getString("reason") || "No reason provided";
      const warns = await loadWarnings();

      if (!warns[interaction.guild.id]) warns[interaction.guild.id] = {};
      if (!warns[interaction.guild.id][target.id]) warns[interaction.guild.id][target.id] = [];

      warns[interaction.guild.id][target.id].push({
        moderator: interaction.user.tag,
        reason,
        time: new Date().toISOString()
      });

      await saveWarnings(warns);
      await interaction.reply({ 
        content: `⚠️ Warned ${target.tag}: ${reason}`,
        flags: 64 
      });
      await sendLog(client, `⚠️ ${interaction.user.tag} warned ${target.tag}: ${reason}`);
    }

    if (cmd === "warnings") {
      const target = interaction.options.getUser("user") || interaction.user;
      const warns = await loadWarnings();
      const list = (warns[interaction.guild.id] && warns[interaction.guild.id][target.id]) || [];

      if (list.length === 0) {
        return interaction.reply({ 
          content: `${target.tag} has no warnings.`, 
          flags: 64 
        });
      }

      const lines = list.map((w, i) => `${i + 1}. ${w.reason} — by ${w.moderator} on ${new Date(w.time).toLocaleDateString()}`).join("\n");
      await interaction.reply({ 
        content: `Warnings for ${target.tag}:\n${lines}`, 
        flags: 64 
      });
    }

    if (cmd === "clear") {
      const member = interaction.member;
      if (!isModerator(member)) {
        return interaction.reply({ 
          content: "❌ You need moderator permissions to use this command.", 
          flags: 64 
        });
      }

      const amount = interaction.options.getInteger("amount");

      if (amount < 1 || amount > 100) {
        return interaction.reply({ 
          content: "❌ Amount must be between 1 and 100.", 
          flags: 64 
        });
      }

      const channel = interaction.channel;

      try {
        const deleted = await channel.bulkDelete(amount, true);
        await interaction.reply({ 
          content: `🧹 Deleted ${deleted?.size || 0} messages.`, 
          flags: 64 
        });
        await sendLog(client, `🧹 ${interaction.user.tag} deleted ${deleted?.size || 0} messages in #${channel.name}`);
      } catch (err) {
        await interaction.reply({ 
          content: "❌ Failed to delete messages.", 
          flags: 64 
        });
      }
    }

    // === XP/LEVELING COMMANDS (Guild-specific, secondary server only) ===

    if (cmd === "level") {
      const target = interaction.options.getUser("user") || interaction.user;
      const info = await getUserLevelInfo(interaction.guild.id, target.id);

      const embed = {
        color: 0x00AA00,
        title: `📊 ${target.username}'s Level Info`,
        fields: [
          { name: "Level", value: `${info.level}`, inline: true },
          { name: "Total XP", value: `${info.totalXP}`, inline: true },
          { name: "Current Level XP", value: `${info.xpInCurrentLevel}/${info.xpNeededForThisLevel}`, inline: false }
        ],
        thumbnail: { url: target.displayAvatarURL() }
      };

      await interaction.reply({ embeds: [embed] });
    }

    if (cmd === "leaderboard") {
      const users = await getLeaderboard(interaction.guild.id, 10);

      if (users.length === 0) {
        return interaction.reply({ 
          content: "No users have leveled up yet!", 
          flags: 64 
        });
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

  } catch (err) {
    console.error("Interaction error:", err);
    await interaction.reply({ 
      content: "⚠️ An error occurred while processing the command.", 
      flags: 64 
    });
    await sendLog(client, `⚠️ Command error: ${err.message}`);
  }
});

// === Message handler (AI via !chat or mention + XP gain) ===
client.on("messageCreate", async message => {
  try {
    // Give XP for any message (only in non-disabled guilds)
    if (!message.author.bot && message.guild && !DISABLED_LEVELING_GUILDS.includes(message.guild.id)) {
      const result = await addXPToUser(message.guild.id, message.author.id);

      // Notify user on level up
      if (result.leveledUp) {
        await sendLevelUpMessage(client, message.author.id, result.newLevel, result.totalXP, message.guild.id);
      }
    }

    // AI reply logic (only in allowed channels)
    if (!shouldReply(message)) return;

    const text = extractUserText(message);
    await message.channel.sendTyping();
    const reply = await callOpenRouter(message.author.id, text);
    await sendLog(client, `💭 ${message.author.tag}: ${text}`);

    if (reply.length <= 2000) {
      return message.reply(reply);
    }

    const parts = reply.match(/[\s\S]{1,1900}/g) || [reply];
    for (const p of parts) {
      await message.reply(p);
    }
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