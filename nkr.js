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
const GUILD_ID = process.env.GUILD_ID;
const GENERAL_CHANNEL_ID = process.env.GENERAL_CHANNEL_ID; // for public mod messages
const LEVEL_UP_CHANNEL_ID = process.env.LEVEL_UP_CHANNEL_ID; // for level-up announcements
process.env.GENERAL_CHANNEL_ID = GENERAL_CHANNEL_ID;
if (!DISCORD_BOT_TOKEN) {
  console.error("Missing DISCORD_BOT_TOKEN in environment. Exiting.");
  process.exit(1);
}
const DISABLED_AI_CHANNELS = [
  "1500364318435446814",
  "1495280739674099892"
];

// === Leveling System Config ===
const XP_PER_MESSAGE = 10; // Base XP per message
const LEVEL_MULTIPLIER = 1.2; // Each level requires 20% more XP (1.2x)
const LEVEL_FILE = path.resolve("./levels.json");

// Calculate XP needed for a level
function getXPForLevel(level) {
  // Level 1 = 10 XP, Level 2 = 12 XP (10 * 1.2), Level 3 = 14.4 XP, etc.
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
    return {}; // { guildId: { userId: { level: 1, totalXP: 0 } } }
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
  
  // Check for level up
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
    const channel = await client.channels.fetch(process.env.GENERAL_CHANNEL_ID);
    if (channel && channel.isTextBased()) {
      await channel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error("Failed to send to general:", err);
  }
}

// Send level-up message to dedicated channel
async function sendLevelUpMessage(client, userId, newLevel, totalXP, guildId) {
  try {
    if (!LEVEL_UP_CHANNEL_ID) return; // Skip if channel not set
    const channel = await client.channels.fetch(LEVEL_UP_CHANNEL_ID);
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
  console.error("Interaction error:", err);

  const msg = "⚠️ An error occurred while processing the command.";

  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(msg);
    } else {
      await interaction.reply({ content: msg, flags: 64 });
    }
  } catch {}

  await sendLog(client, `⚠️ Command error: ${err.message}`);
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

  // Allow DMs
  if (message.channel?.type === 1) return true;

  // Disable AI in specific channels
  if (DISABLED_AI_CHANNELS.includes(message.channel.id)) {
    return false;
  }

  // Mention AI
  if (message.mentions?.has(client.user)) return true;

  // ! AI trigger
  if (message.content.trim().toLowerCase().startsWith("!")) {
    return true;
  }

  return false;
}
function extractUserText(message) {
  let text = message.content.trim();
  if (text.toLowerCase().startsWith("!")) text = text.slice("!".length).trim();
  const mention = `<@${client.user.id}>`;
  const mentionNick = `<@!${client.user.id}>`;
  text = text.replaceAll(mention, "").replaceAll(mentionNick, "").trim();
  return text.length ? text : "Say hello!";
}

// === Slash commands list (includes moderation + leveling) ===
const commands = [
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask the AI something")
    .addStringOption(o => o.setName("question").setDescription("Your question").setRequired(true)),
  new SlashCommandBuilder().setName("help").setDescription("Show help menu"),
  new SlashCommandBuilder().setName("donate").setDescription("Support the bot"),
  // Leveling Commands
  new SlashCommandBuilder()
    .setName("level")
    .setDescription("Check your level and XP")
    .addUserOption(o => o.setName("user").setDescription("User to check (optional)")),
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Show top 10 users by level"),
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
    .addIntegerOption(o => o.setName("amount").setDescription("Number of messages").setRequired(true))
];

// === Register slash commands ===
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const rest = new REST().setToken(DISCORD_BOT_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
      body: commands.map(cmd => cmd.toJSON())
    });
    console.log("✅ Slash commands registered!");
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
      const reply = await callOpenRouter(interaction.user.id, question);
      await interaction.editReply(reply.slice(0, 2000));
      await sendLog(client, `💬 /ask by ${interaction.user.tag}: ${question}`);
    }

    // help
    if (cmd === "help") {
      await interaction.reply({
        embeds: [{ 
          title: "NKR.bot Help", 
          description: "**/ask** • Ask the AI\n**/donate** • Support\n**/level** • Check your level\n**/leaderboard** • See top users\n\n**Moderation:** /kick /ban /mute /warn /warnings /clear", 
          color: 0x5865f2 
        }],
        ephemeral: true
      });
    }

    // donate
    if (cmd === "donate") {
      await interaction.reply({ content: "Support: https://ko-fi.com/yourlink", flags: 64 });
    }

    // === LEVELING COMMANDS ===
    
    // level - Check user level
    if (cmd === "level") {
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
      const users = await getLeaderboard(interaction.guild.id, 10);
      
      if (users.length === 0) {
        return interaction.reply({ content: "No users have leveled up yet!", flags: 64 });
      }
      
      let description = "";
      for (let i = 0; i < users.length; i++) {
        const user = await client.users.fetch(users[i].userId).catch(() => null);
        const username = user ? user.username : "Unknown User";
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

    // === MODERATION COMMANDS ===

    // kick
    if (cmd === "kick") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.KickMembers)) return interaction.reply({ content: "You lack Kick Members permission.", flags: 64 });
      const target = interaction.options.getUser("target");
      const reason = interaction.options.getString("reason") || "No reason provided";
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      if (!member) return interaction.reply({ content: "Member not found.", flags: 64 });
      if (!member.kickable) return interaction.reply({ content: "I cannot kick that user.", flags: 64 });
      await member.kick(reason);
      await interaction.reply(`✅ Kicked ${target.tag} — ${reason}`);
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

    // ban
    if (cmd === "ban") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.BanMembers)) return interaction.reply({ content: "You lack Ban Members permission.", flags: 64 });
      const target = interaction.options.getUser("target");
      const reason = interaction.options.getString("reason") || "No reason provided";
      await interaction.guild.members.ban(target.id, { reason }).catch(err => { throw err; });
      await interaction.reply({content: `✅ Banned ${target.tag}`,flags: 64});
      await sendLog(client, `🔨 ${interaction.user.tag} banned ${target.tag} — ${reason}`);

      await sendPublicModMessage(
        client,
        "User Banned",
        target,
        interaction.user,
        reason,
        { color: 0xff0000 }
      );
    }

    // unban
    if (cmd === "unban") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.BanMembers))
        return interaction.reply({ content: "You lack Ban Members permission.", flags: 64 });

      const userId = interaction.options.getString("userid");

      try {
        await interaction.guild.members.unban(userId);
        await interaction.reply(`✅ Unbanned user with ID ${userId}`);
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
        await interaction.reply({ content: "Failed to unban. Check the user ID.", flags: 64 });
      }
    }

    // unmute (remove timeout) 
    if (cmd === "unmute") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.ModerateMembers))
        return interaction.reply({ content: "You lack Moderate Members permission.", flags: 64 });

      const target = interaction.options.getUser("target");
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);

      if (!member)
        return interaction.reply({ content: "Member not found.", flags: 64 });

      await member.timeout(null, `Unmuted by ${interaction.user.tag}`).catch(e => { throw e; });

      await interaction.reply(`🔊 ${target.tag} has been unmuted.`);
      await sendLog(client, `🔊 ${interaction.user.tag} unmuted ${target.tag}`);
      await sendPublicModMessage(
        client,
        "User Unmuted",
        target,
        interaction.user,
        "Timeout removed",
        { color: 0x2ECC71 }
      );
    }

    // mute (timeout)
    if (cmd === "mute") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.ModerateMembers)) return interaction.reply({ content: "You lack Moderate Members permission.", flags: 64 });
      const target = interaction.options.getUser("target");
      const minutes = interaction.options.getInteger("minutes");
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      if (!member) return interaction.reply({ content: "Member not found.", flags: 64 });
      const until = minutes > 0 ? Date.now() + minutes * 60 * 1000 : null;
      await member.timeout(minutes * 60 * 1000, `Muted by ${interaction.user.tag}`).catch(e => { throw e; });
      await interaction.reply(`🔇 ${target.tag} muted for ${minutes} minute(s).`);
      await sendPublicModMessage(
        client,
        "User Muted",
        target,
        interaction.user,
        "Timeout",
        { duration: `${minutes} minute(s)`, color: 0xFFD700 }
      );
    }

    // warn
    if (cmd === "warn") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.KickMembers)) return interaction.reply({ content: "You lack permission to warn.", flags: 64 });
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
      const target = interaction.options.getUser("user") || interaction.user;
      const warns = await loadWarnings();
      const list = (warns[interaction.guild.id] && warns[interaction.guild.id][target.id]) || [];
      if (list.length === 0) return interaction.reply({ content: `${target.tag} has no warnings.`, flags: 64 });
      const lines = list.map((w, i) => `${i + 1}. ${w.reason} — by ${w.moderator} on ${w.time}`).join("\n");
      await interaction.reply({ content: `Warnings for ${target.tag}:\n${lines}`, flags: 64 });
    }

    // clear messages
    if (cmd === "clear") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageMessages)) return interaction.reply({ content: "You lack Manage Messages permission.", flags: 64 });
      const amount = interaction.options.getInteger("amount");
      if (amount < 1 || amount > 100) return interaction.reply({ content: "Amount must be between 1 and 100.", flags: 64 });
      const channel = interaction.channel;
      const deleted = await channel.bulkDelete(amount, true).catch(() => null);
      await interaction.reply({ content: `🧹 Deleted ${deleted?.size || 0} messages.`, flags: 64 });
      await sendLog(client, `🧹 ${interaction.user.tag} deleted ${deleted?.size || 0} messages in #${channel.name}`);
    }

  } catch (err) {
    console.error("Interaction error:", err);
    await interaction.reply({ content: "⚠️ An error occurred while processing the command.", flags: 64 });
    await sendLog(client, `⚠️ Command error: ${err.message}`);
  }
});

// === Message handler (AI via !chat or mention + XP gain) ===
client.on("messageCreate", async message => {
  try {
    // Give XP for any message (not just AI trigger messages)
    if (!message.author.bot && message.guild) {
      const result = await addXPToUser(message.guild.id, message.author.id);
      
      // Notify user on level up (send to dedicated channel)
      if (result.leveledUp) {
        await sendLevelUpMessage(client, message.author.id, result.newLevel, result.totalXP, message.guild.id);
      }
    }

    // AI reply logic
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
