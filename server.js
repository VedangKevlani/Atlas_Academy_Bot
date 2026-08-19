import "dotenv/config";
import { createAtlasBot } from "atlas-bot-sdk";
import { createClient } from "@supabase/supabase-js";
import http from "node:http";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Intellibus Academy Bot is running.");
  })
  .listen(PORT, () => console.log(`Health check server listening on port ${PORT}`));

const bot = createAtlasBot({
  accessToken: process.env.ATLAS_BOT_TOKEN,
  instructions: `You are the Intellibus Academy Bot, a friendly and 
  professional learning assistant for Intellibus Academy. 
  Your job is to help users find training content on any topic.
  Always greet warmly, ask what topic they want to learn about,
  then ask which format they prefer before fetching anything.
  Never assume a format — always ask first.`
});

// this is the content lookup tool 

bot.tools.register("find_course_content", {
  description: "Find a specific piece of course content by topic and format",
  parameters: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description: "The course or subject the user wants to learn"
      },
      format: {
        type: "string",
        enum: ["infographic", "video", "slide_deck", "audio"],
        description: "The content format the user selected"
      }
    },
    required: ["topic", "format"]
  },
  handler: async ({ topic, format }) => {

    // paths.topic groups content; media_assets.asset_type stores the format,
    // but under "deck" rather than "slide_deck"
    const assetType = format === "slide_deck" ? "deck" : format;

    const { data: path, error: pathError } = await supabase
      .from("paths")
      .select("id")
      .ilike("topic", topic)
      .eq("is_published", true)
      .maybeSingle();

    if (pathError) {
      console.error("Supabase path lookup failed:", pathError.message);
      return { found: false, topic, format };
    }

    if (!path) {
      return { found: false, topic, format };
    }

    const { data: asset, error: assetError } = await supabase
      .from("media_assets")
      .select("title, description, bucket, storage_path")
      .eq("path_id", path.id)
      .eq("asset_type", assetType)
      .eq("is_published", true)
      .maybeSingle();

    if (assetError) {
      console.error("Supabase media asset lookup failed:", assetError.message);
      return { found: false, topic, format };
    }

    if (!asset) {
      return { found: false, topic, format };
    }

    const { data: publicUrl } = supabase
      .storage
      .from(asset.bucket)
      .getPublicUrl(asset.storage_path);

    return {
      found: true,
      topic,
      format,
      title: asset.title,
      description: asset.description,
      url: publicUrl.publicUrl
    };
  }
});

// this is the /start command 
bot.onCommand("start", async (ctx) => {
  await ctx.sendChoices(
    "👋 Welcome to Intellibus Academy! I can help you find training content on any topic. What would you like to do?",
    [
      { label: "🎓 Find course content", value: "/findcourse" },
      { label: "❓ Help",                value: "/help"       }
    ]
  );
});

// this is the /findcourse command 
bot.onCommand("findcourse", async (ctx) => {
  await ctx.sendText(
    "What topic or subject would you like to learn about?\n\n" +
    "For example: *Project Management*, *Python Programming*, *Postman API Testing*"
  );
});

// this is the /help command 
bot.onCommand("help", async (ctx) => {
  await ctx.sendText(
    "Here's what I can do:\n\n" +
    "🔹 Find training content on any topic\n" +
    "🔹 Deliver it in your preferred format:\n\n" +
    "   1. 🖼️  Infographic\n" +
    "   2. 🎬  Video\n" +
    "   3. 📊  Slide Deck\n" +
    "   4. 🎧  Audio\n\n" +
    "Just tell me what you want to learn and I'll guide you from there."
  );
});

// all other messages - handled by the platform LLM
bot.onMessage(async (ctx) => {

  // after the LLM determines the topic, it offers format choices as buttons
  const turn = await ctx.think({
    tools: {
      // this is an offer format picker as a tool the LLM can call mid-conversation
      ask_format_preference: {
        description: "Ask the user to choose their preferred content format using buttons",
        parameters: {
          type: "object",
          properties: {
            topic: {
              type: "string",
              description: "The topic the user wants content for"
            }
          },
          required: ["topic"]
        },
        handler: async ({ topic }) => {
          await ctx.sendChoices(
            `Great! Here are the available formats for *${topic}*. Which do you prefer?`,
            [
              { label: "🖼️  Infographic", value: `/getformat infographic ${topic}` },
              { label: "🎬  Video",        value: `/getformat video ${topic}`       },
              { label: "📊  Slide Deck",   value: `/getformat slide_deck ${topic}`  },
              { label: "🎧  Audio",        value: `/getformat audio ${topic}`       }
            ]
          );
          return { offered: true, topic };
        }
      }
    }
  });

  if (turn.reply) await ctx.sendText(turn.reply);
});

// this is the /getformat command - it fires when user taps a format button 
bot.onCommand("getformat", async (ctx) => {
  const [format, ...topicParts] = ctx.args;   // e.g. ["video", "Project", "Management"]
  const topic = topicParts.join(" ");

  if (!format || !topic) {
    await ctx.sendText("Sorry, I lost track of what you were looking for. Type /findcourse to start again.");
    return;
  }

  await ctx.sendText(`🔍 Looking up the ${format.replace("_", " ")} for *${topic}*...`);

  // Call the content lookup tool directly
  const result = await bot.tools.call("find_course_content", { topic, format });

  if (result.found) {
    await ctx.sendText(
      `✅ *${result.title}*\n\n` +
      `${result.description}\n\n` +
      `📎 Access it here:\n${result.url}`
    );

    // this is an offer to find another format or topic
    await ctx.sendChoices(
      "What would you like to do next?",
      [
        { label: "🔄 Different format, same topic", value: `/findcourse` },
        { label: "🎓 Find a new topic",              value: `/findcourse` },
        { label: "🏠 Back to start",                 value: `/start`     }
      ]
    );
  } else {
    await ctx.sendText(
      `😕 I couldn't find a ${format.replace("_", " ")} for *${topic}* right now.\n\n` +
      `Try a different format or topic, or contact the Intellibus Academy team for help.`
    );
  }
});

bot.start();
console.log("Intellibus Academy Bot is running...");