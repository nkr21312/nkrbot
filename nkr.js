// ================= ENV =================
import dotenv from "dotenv";
dotenv.config(); // Render provides env automatically

// ================= IMPORTS =================
import {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionFlagsBits
} from "discord.js";
import express from "express";

// ================= CONFIG =================
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN) {
  console.error("❌ DISCORD_BOT_TOKEN missing");
  process.exit(1);
}

// ================= CLIENT =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

// ================= KEEP ALIVE (Render) =================
const app = express();
app.get("/", (_, res) => res.send("Bot alive"));
app.listen(process.env.PORT || 3000);

// ================= COMMANDS =================
const globalCommands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check if bot is online"),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show help")
].map(c => c.toJSON());

const guildCommands = [
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member")
    .addUserOption(o =>
      o.setName("target").setDescription("User").setRequired(true)
    )
].map(c => c.toJSON());

// ================= REGISTER COMMANDS =================
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  await rest.put(
    Routes.applicationCommands(client.user.id),
    { body: globalCommands }
  );

  await rest.put(
    Routes.applicationGuildCommands(client.user.id, GUILD_ID),
    { body: guildCommands }
  );

  console.log("✅ Slash commands registered");
}

// ================= READY =================
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
});

// ================= INTERACTIONS =================
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "ping") {
      await interaction.reply("🏓 Pong! Bot is online.");
    }

    if (interaction.commandName === "help") {
      await interaction.reply({
        content: "/ping • /help • /kick",
        ephemeral: true
      });
    }

    if (interaction.commandName === "kick") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.KickMembers)) {
        return interaction.reply({ content: "❌ No permission", ephemeral: true });
      }

      const user = interaction.options.getUser("target");
      const member = await interaction.guild.members.fetch(user.id);
      await member.kick();
      await interaction.reply(`✅ Kicked ${user.tag}`);
    }

  } catch (err) {
    console.error(err);
    if (!interaction.replied) {
      await interaction.reply({ content: "⚠️ Error occurred", ephemeral: true });
    }
  }
});

// ================= START =================
client.login(TOKEN);
