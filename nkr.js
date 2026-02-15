import { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } from "discord.js";
import express from "express";

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN) throw new Error("DISCORD_BOT_TOKEN missing");
if (!GUILD_ID) throw new Error("GUILD_ID missing");

// =====================
// CLIENT
// =====================
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// =====================
// KEEP ALIVE (Render)
// =====================
const app = express();
app.get("/", (_, res) => res.send("Bot alive"));
app.listen(process.env.PORT || 3000);

// =====================
// COMMANDS
// =====================
const guildCommands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Test command")
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(client.user.id, GUILD_ID),
    { body: guildCommands }
  );

  console.log("✅ Commands registered");
}

// =====================
// READY
// =====================
client.once("ready", async () => {
  console.log(`ONLINE as ${client.user.tag}`);
  await registerCommands();
});

// =====================
// INTERACTION
// =====================
client.on("interactionCreate", async i => {
  if (!i.isChatInputCommand()) return;

  if (i.commandName === "ping")
    await i.reply("Pong! Bot works on Render ✅");
});

// =====================
// LOGIN
// =====================
console.log("Starting Discord login...");
client.login(TOKEN)
  .then(() => console.log("LOGIN SUCCESS"))
  .catch(err => console.error("LOGIN FAILED:", err));
