import { Client, GatewayIntentBits, REST, Routes } from "discord.js";
import axios from "axios";
import fs from "fs";
// === Tokens ===
const DISCORD_TOKEN = "MTI1NTkwNTU4NzY2MTg5Nzc4MA.GDZ9KW.rk4m6-8a6YHhtbSXJ1HdLEXbnJC6FyRsCvVRQA";
const OPENROUTER_API_KEY = "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"; // GPT chat
const BFL_API_KEY = "f1451749-e286-4cd1-9ee7-38b91e2b4ce0"; // Black Forest Labs FLUX image generation

// === Create client ===
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
});

// === Slash commands ===
const commands = [
  { name: "ping", description: "Replies with Pong!" },
  {
    name: "clear",
    description: "Clears messages",
    options: [
      { name: "amount", type: 4, description: "Number of messages to delete", required: true }
    ]
  },
  {
    name: "ask",
    description: "Ask AI a question",
    options: [
      { name: "question", type: 3, description: "Your question", required: true }
    ]
  },
  {
    name: "image",
    description: "Generate an image",
    options: [
      { name: "prompt", type: 3, description: "Image prompt", required: true }
    ]
  }
];

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

// === Register slash commands (PER-GUILD, NOT GLOBAL) ===
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const guildId = "1255904591875280997"; // <---- REPLACE THIS WITH YOUR SERVER ID

  try {
    console.log("Registering slash commands for your server only...");
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, guildId),
      { body: commands }
    );
    console.log("✅ Slash commands registered ONLY for this server!");
  } catch (error) {
    console.error("❌ Error registering slash commands:", error);
  }
});

// === Conversation memory ===
const conversationMemory = {};

// === Slash command handling ===
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;

  if (interaction.commandName === "ping") {
    await interaction.reply("🏓 Pong!");
  }

  else if (interaction.commandName === "clear") {
    const amount = interaction.options.getInteger("amount");
    try {
      const msgs = await interaction.channel.bulkDelete(amount, true);
      await interaction.reply(`🧹 Deleted ${msgs.size} messages`);
    } catch (err) {
      console.error(err);
      await interaction.reply("⚠️ Failed to delete messages");
    }
  }

  else if (interaction.commandName === "ask") {
    const q = interaction.options.getString("question");
    await interaction.deferReply();

    try {
      if (!conversationMemory[interaction.user.id])
        conversationMemory[interaction.user.id] = [];

      conversationMemory[interaction.user.id].push({ role: "user", content: q });

      const res = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model: "openai/gpt-oss-20b:free",
          messages: conversationMemory[interaction.user.id]
        },
        { headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" } }
      );

      const reply = res.data.choices[0].message.content;
      conversationMemory[interaction.user.id].push({ role: "assistant", content: reply });

      await interaction.editReply(reply.slice(0, 2000));
    } catch (err) {
      console.error(err);
      await interaction.editReply("⚠️ Failed to get AI response");
    }
  }

  else if (interaction.commandName === "image") {
    const prompt = interaction.options.getString("prompt");
    await interaction.deferReply();

    try {
      const res = await axios.post(
        "https://api.bfl.ai/v1/generate",
        {
          model: "black-forest-labs/FLUX.1-dev",
          inputs: prompt
        },
        {
          headers: { Authorization: `Bearer ${BFL_API_KEY}`, "Content-Type": "application/json" },
          responseType: "arraybuffer"
        }
      );

      const filename = `image_${Date.now()}.png`;
      fs.writeFileSync(filename, res.data);

      await interaction.editReply({ files: [filename] });
      fs.unlinkSync(filename);
    } catch (err) {
      console.error(err);
      await interaction.editReply("⚠️ Failed to generate image.");
    }
  }
});

// === Prefix commands (!something) ===
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith("!")) return;

  const input = message.content.slice(1).trim();
  await message.channel.sendTyping();

  try {
    if (!conversationMemory[message.author.id])
      conversationMemory[message.author.id] = [];

    conversationMemory[message.author.id].push({ role: "user", content: input });

    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "openai/gpt-oss-20b:free",
        messages: conversationMemory[message.author.id]
      },
      { headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" } }
    );

    const reply = res.data.choices[0].message.content;
    conversationMemory[message.author.id].push({ role: "assistant", content: reply });

    message.reply(reply.slice(0, 2000));
  } catch (err) {
    console.error(err);
    message.reply("⚠️ Failed to get AI response");
  }
});

client.login(DISCORD_TOKEN);
