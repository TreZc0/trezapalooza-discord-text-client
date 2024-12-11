import fs from 'node:fs';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, Events } from 'discord.js';
import WebSocket from 'ws';
globalThis.WebSocket = WebSocket;
import { Client as ArchClient} from "archipelago.js";

// Load the configuration
let config;
try {
    const data = fs.readFileSync('config.json', 'utf8');
    config = JSON.parse(data);
    if (!config.token) {
        console.error("The config.json file is missing a 'token' property.");
        process.exit(1);
    }
} catch (err) {
    console.error("Error reading config.json. Please create it with a 'token' property.");
    process.exit(1);
}

const token = config.token;

// Create Discord client
const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Map<threadId, { archClient: ArchClient, host: string, port: number, slotName: string, game: string }>
const activeSessions = new Map();

// Define the /connect command
const connectCommand = new SlashCommandBuilder()
    .setName('connect')
    .setDescription('Connect this channel to an TreZapalooza server')
    .addIntegerOption(option =>
        option.setName('port')
            .setDescription('Server port')
            .setRequired(true))
    .addStringOption(option =>
        option.setName('slotname')
            .setDescription('Player slot name')
            .setRequired(true))
    .addStringOption(option =>
        option.setName('host')
            .setDescription('Server host, default: trezapalooza.com')
            .setRequired(false));

discordClient.once(Events.ClientReady, async () => {
    console.log(`Logged in as ${discordClient.user.tag}!`);

    const rest = new REST({ version: '10' }).setToken(token);

    const commands = [connectCommand];

    try {
        await rest.put(
            Routes.applicationCommands(discordClient.user.id),
            { body: commands.map(cmd => cmd.toJSON()) }
        );
        console.log("Slash commands registered globally.");
    } catch (error) {
        console.error("Error registering commands:", error);
    }
});

discordClient.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'connect') {
        const host = interaction.options.getString('host') || 'trezapalooza.com';
        const port = interaction.options.getInteger('port');
        const slotName = interaction.options.getString('slotname');

        await interaction.deferReply({ ephemeral: true });

        const archClient = new ArchClient();

        try {
            await archClient.login(`${host}:${port}`, slotName);

            const parentChannel = interaction.channel;
            if (!parentChannel?.isTextBased()) {
                throw new Error("This command must be used in a text-based channel.");
            }

            const threadName = `${host.replace(/\./g, '-')}-${port}-${slotName}`;
            const thread = await parentChannel.threads.create({
                name: threadName,
                autoArchiveDuration: 1440, // 24 hours
                reason: `TreZapalooza session: ${host}:${port} as ${slotName}`
            });

            archClient.messages.on('message', (content) => {
                const isEcho = content.includes(': ') && content.split(': ')[0].length > 0;
                if (isEcho) {
                    return;
                }
            
                thread.send(content);
            });
            activeSessions.set(thread.id, {
                archClient,
                host,
                port,
                slotName
            });

            await interaction.editReply(`Connected to TreZapalooza at ${host}:${port} as ${slotName}. A thread has been created: <#${thread.id}>`);
        } catch (err) {
            console.error(err);
            await interaction.editReply(`Failed to connect: ${err.message}`);
        }
    }
});

// Handle messages in the threads and send them to TreZapalooza with the author's name prefixed
discordClient.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;

    if (message.channel.isThread()) {
        const sessionData = activeSessions.get(message.channel.id);
        console.log("checking for session", message.channel.id);
        if (!sessionData) return;
        console.log("session found");

        const { archClient } = sessionData;
        try {
            const prefixedMessage = `${message.author.username}: ${message.content}`;
            await archClient.messages.say(prefixedMessage);
        } catch (err) {
            console.error("Failed to send message to TreZapalooza:", err);
            message.channel.send("Error: Unable to send message to the TreZapalooza server.");
        }
    }
});

// Handle thread deletion, clean up the session
discordClient.on(Events.ThreadDelete, async thread => {
    const sessionData = activeSessions.get(thread.id);
    if (sessionData) {
        const { archClient } = sessionData;
        try {
            await archClient.disconnect();
        } catch (err) {
            console.error("Error disconnecting from TreZapalooza:", err);
        }
        activeSessions.delete(thread.id);
        console.log(`Session closed for thread ${thread.id}`);
    }
});

//Helper Functions
function escapeDiscordSpecials(inputString) {
    return inputString.replace(/_/g, "\\_").replace(/\*/g, "\\*").replace(/~/g, "\\~");
}

discordClient.login(token).catch(console.error);
