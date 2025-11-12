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
  Routes
} from "discord.js";
import fetch from "node-fetch";
import express from "express";

// === Tokens ===
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// === Log Channel ID ===
const LOG_CHANNEL_ID = "1438026605011140608";

// === Discord Client ===
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

// === Keep-alive web server for Render.com ===
const app = express();
app.get("/", (req, res) => res.send("🧠 NKR.bot is alive!"));
app.listen(3000, () =>
  console.log("🌐 Keep-alive web server running on port 3000")
);

// === Memory System (store last 10 messages per user) ===
const memory = new Map();

// === Log helper ===
async function sendLog(client, content) {
  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (channel && channel.isTextBased()) {
      await channel.send(content);
    }
  } catch (err) {
    console.error("Failed to send log:", err);
  }
}

// === Helper Functions ===
function shouldReply(message) {
  if (message.author.bot) return false;
  if (message.channel?.type === 1) return true; // DM
  if (message.mentions?.has(client.user)) return true;
  if (message.content.trim().toLowerCase().startsWith("!chat")) return true;
  return false;
}

function extractUserText(message) {
  let text = message.content.trim();
  if (text.toLowerCase().startsWith("!chat")) {
    text = text.slice("!chat".length).trim();
  }
  const mention = `<@${client.user.id}>`;
  const mentionNick = `<@!${client.user.id}>`;
  text = text.replaceAll(mention, "").replaceAll(mentionNick, "").trim();
  return text.length ? text : "Say hello!";
}

// === OpenRouter API Call ===
async function callOpenRouter(userId, userText) {
  if (!memory.has(userId)) memory.set(userId, []);
  const convo = memory.get(userId);

  convo.push({ role: "user", content: userText });
  if (convo.length > 10) convo.splice(0, convo.length - 10);

  const body = {
    model: "openai/gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "You are a friendly, smart Discord AI assistant with short, clear answers."
      },
      ...convo
    ],
    max_tokens: 500
  };

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://discordapp.com",
      "X-Title": "nkr.bot AI"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) throw new Error(`OpenRouter error ${res.status}`);

  const data = await res.json();
  const reply =
    data?.choices?.[0]?.message?.content?.trim() ||
    "I couldn’t think of a reply.";
  convo.push({ role: "assistant", content: reply });
  return reply;
}

// === Slash Commands ===
const commands = [
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask the AI something")
    .addStringOption(opt =>
      opt
        .setName("question")
        .setDescription("Your question or message")
        .setRequired(true)
    ),
  new SlashCommandBuilder().setName("help").setDescription("Show help menu"),
  new SlashCommandBuilder()
    .setName("donate")
    .setDescription("Support the bot ❤️")
].map(cmd => cmd.toJSON());

// === Register Slash Commands ===
async function registerSlashCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands
    });
    console.log("✅ Slash commands registered!");
  } catch (err) {
    console.error("❌ Command registration failed:", err);
  }
}

// === On Ready ===
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerSlashCommands();

  // === Rotating Presence ===
  const activities = [
    { name: "🧠 AI chat | /ask", type: 0 },
    { name: "💬 Use /ask in DM or server", type: 0 },
    { name: "⚙️ Mention me or use !chat", type: 0 },
    { name: "❤️ NKR.bot Online", type: 0 },
    { name: "📜 /help for commands", type: 0 },
    { name: "💡 You can DM me to ask questions!", type: 0 },
    { name: "👀 Watching your questions roll in", type: 3 },
    { name: "🎯 Helping users with AI replies", type: 0 },
    { name: "📩 DM me — I reply instantly!", type: 0 },
    { name: "🧩 Chat smarter | Use /ask or !chat", type: 0 },
    { name: "✨ Powered by OpenRouter AI", type: 0 },
    { name: "🕹️ Talking to humans 24/7", type: 0 },
    { name: "💻 Serving the NKR community", type: 0 },
    { name: "🌍 Active in multiple servers", type: 3 },
    { name: "⚡ /ask | Instant AI answers", type: 0 },
    { name: "💭 Thinking deeply...", type: 0 },
    { name: "🎮 Online and ready to chat", type: 0 },
    { name: "📢 Invite me to your server!", type: 0 },
    { name: "🚀 Ask me anything, anytime", type: 0 },
    { name: "🛠️ Constantly improving my AI", type: 0 },
    { name: "🔍 Type /help for full command list", type: 0 },
    { name: "🤖 Developed by Nikhil Kr", type: 0 },
    { name: "🪄 Magic happens with /ask", type: 0 },
    { name: "💬 I reply faster than Google 😉", type: 0 }
  ];

  let i = 0;
  setInterval(() => {
    client.user.setPresence({
      status: "online",
      activities: [activities[i]]
    });
    i = (i + 1) % activities.length;
  }, 15_000);

  console.log("🎮 Presence rotation active!");
  await sendLog(client, "✅ NKR.bot is now online!");
});

// === Handle Slash Commands ===
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  if (commandName === "ask") {
    const question = interaction.options.getString("question");
    await interaction.deferReply();

    try {
      const reply = await callOpenRouter(interaction.user.id, question);
      await interaction.editReply(reply.slice(0, 2000));
      await sendLog(client, `💬 ${interaction.user.tag} used /ask: ${question}`);
    } catch (err) {
      console.error(err);
      await sendLog(client, `⚠️ Error in /ask: ${err.message}`);
      await interaction.editReply("⚠️ Something went wrong talking to the AI.");
    }
  }

  if (commandName === "help") {
    await interaction.reply({
      embeds: [
        {
          title: "📜 NKR.bot Help",
          description: `
**/ask** → Ask the AI something  
**/help** → Show this help menu  
**/donate** → Support the bot  
**!chat [message]** → Chat directly  
Mention or DM me to talk privately.`,
          color: 0x5865f2
        }
      ],
      ephemeral: true
    });
  }

  if (commandName === "donate") {
    await interaction.reply({
      content:
        "❤️ Support NKR.bot:\n👉 [Patreon](https://patreon.com/yourname)\n👉 [Ko-fi](https://ko-fi.com/yourname)",
      ephemeral: true
    });
  }
});

// === Handle normal messages ===
client.on("messageCreate", async message => {
  try {
    if (!shouldReply(message)) return;

    const userText = extractUserText(message);
    await message.channel.sendTyping();

    const reply = await callOpenRouter(message.author.id, userText);
    await sendLog(client, `💭 ${message.author.tag}: ${userText}`);

    if (reply.length <= 2000) await message.reply(reply);
    else {
      const parts = reply.match(/[\s\S]{1,1900}/g) || [reply];
      for (const part of parts) await message.reply(part);
    }
  } catch (err) {
    console.error(err);
    await sendLog(client, `⚠️ Error in messageCreate: ${err.message}`);
    await message.reply("⚠️ Sorry, I ran into an error talking to the AI.");
  }
});

// === Start Bot ===
client.login(DISCORD_BOT_TOKEN);
