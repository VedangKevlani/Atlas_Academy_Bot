import "dotenv/config";
import { createAtlasBot } from "atlas-bot-sdk";
import { createClient } from "@supabase/supabase-js";
import http from "node:http";
import { Readable } from "node:stream";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const LEARNING_STYLES = ["audio", "visual", "kinesthetic"];

// proxies media_assets storage objects under our own domain so the
// Supabase project URL is never shown to or hit directly by the user
async function serveMedia(req, res) {
  const assetId = decodeURIComponent(req.url.slice("/media/".length).split("?")[0]);

  const { data: asset, error } = await supabase
    .from("media_assets")
    .select("bucket, storage_path, mime_type")
    .eq("id", assetId)
    .eq("is_published", true)
    .maybeSingle();

  if (error || !asset) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  const { data: publicUrl } = supabase
    .storage
    .from(asset.bucket)
    .getPublicUrl(asset.storage_path);

  const upstream = await fetch(publicUrl.publicUrl);
  if (!upstream.ok || !upstream.body) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Failed to fetch media");
    return;
  }

  res.writeHead(200, {
    "Content-Type": asset.mime_type || upstream.headers.get("content-type") || "application/octet-stream"
  });
  Readable.fromWeb(upstream.body).pipe(res);
}

const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    if (req.url.startsWith("/media/")) {
      serveMedia(req, res).catch((err) => {
        console.error("Media proxy failed:", err.message);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal error");
      });
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Intellibus Academy Bot is running.");
  })
  .listen(PORT, () => console.log(`Health check server listening on port ${PORT}`));

// ---------- learning style preference ----------

async function getUserStyle(userId) {
  const { data, error } = await supabase
    .from("user_preferences")
    .select("learning_style")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("Supabase style lookup failed:", error.message);
    return null;
  }
  return data?.learning_style ?? null;
}

async function setUserStyle(userId, style) {
  const { error } = await supabase
    .from("user_preferences")
    .upsert({ user_id: userId, learning_style: style }, { onConflict: "user_id" });

  if (error) console.error("Supabase style upsert failed:", error.message);
}

function styleChoiceButtons() {
  return [
    { label: "🎧 Audio",       value: "/setstyle audio" },
    { label: "👀 Visual",      value: "/setstyle visual" },
    { label: "🤸 Kinesthetic", value: "/setstyle kinesthetic" }
  ];
}

async function promptLearningStyle(ctx, intro) {
  await ctx.sendChoices(intro, styleChoiceButtons());
}

// ---------- content lookup ----------

async function findPathByTopic(topic) {
  const { data: paths, error } = await supabase
    .from("paths")
    .select("id, slug, topic, title")
    .ilike("topic", `%${topic}%`)
    .eq("is_published", true)
    .limit(1);

  if (error) {
    console.error("Supabase path lookup failed:", error.message);
    return null;
  }
  return paths?.[0] ?? null;
}

async function findAssetForPath(pathId, format) {
  // media_assets.asset_type stores the format, but under "deck" rather than "slide_deck"
  const assetType = format === "slide_deck" ? "deck" : format;

  const { data: asset, error } = await supabase
    .from("media_assets")
    .select("id, title, description")
    .eq("path_id", pathId)
    .eq("asset_type", assetType)
    .eq("is_published", true)
    .maybeSingle();

  if (error) {
    console.error("Supabase media asset lookup failed:", error.message);
    return null;
  }
  if (!asset) return null;

  return {
    title: asset.title,
    description: asset.description,
    url: `${PUBLIC_BASE_URL}/media/${asset.id}`
  };
}

async function findCourseContent({ topic, format }) {
  const path = await findPathByTopic(topic);
  if (!path) return { found: false, topic, format };

  const asset = await findAssetForPath(path.id, format);
  if (!asset) return { found: false, topic, format };

  return { found: true, topic, format, ...asset };
}

// dispatches a resolved topic to the right delivery path for the user's
// learning style — this is the one place style branches into content
async function handleTopicRequest(ctx, topic) {
  const style = await getUserStyle(ctx.sender);
  if (!style) {
    await promptLearningStyle(ctx, "Let's set your learning style first — how do you learn best?");
    return;
  }

  const path = await findPathByTopic(topic);
  if (!path) {
    await ctx.sendText(
      `😕 I couldn't find anything on *${topic}* right now.\n\n` +
      `Try a different topic, or type /suggest for an idea.`
    );
    return;
  }

  if (style === "kinesthetic") {
    await ctx.sendText(
      `🤸 *${path.title}* has hands-on flashcards and quizzes waiting for you on the Intellibus platform:\n\n` +
      `🔗 https://intellibus.academy/learning-paths/${path.slug}\n\n` +
      `(You'll need to be logged into your Intellibus Academy account to access it.)`
    );
    return;
  }

  if (style === "audio") {
    const asset = await findAssetForPath(path.id, "audio");
    if (!asset) {
      await ctx.sendText(
        `😕 I couldn't find audio content for *${path.title}* yet.\n\n` +
        `Try /suggest for another topic, or /style to switch how content is delivered.`
      );
      return;
    }
    await ctx.sendChoices(
      `✅ *${asset.title}*\n\n${asset.description}\n\n📎 Listen here:\n${asset.url}\n\n` +
      `What would you like to do next?`,
      [
        { label: "🎓 Find a new topic", value: "/findcourse" },
        { label: "🏠 Back to start",    value: "/start"      }
      ]
    );
    return;
  }

  // visual
  await ctx.sendChoices(
    `Great choice! Here are the available formats for *${path.title}*. Which do you prefer?`,
    [
      { label: "🖼️  Infographic", value: `/getformat infographic ${path.topic}` },
      { label: "🎬  Video",        value: `/getformat video ${path.topic}`       },
      { label: "📊  Slide Deck",   value: `/getformat slide_deck ${path.topic}`  }
    ]
  );
}

const bot = createAtlasBot({
  accessToken: process.env.ATLAS_BOT_TOKEN,
  instructions: `You are the Intellibus Academy Bot, a friendly and
  professional learning assistant for Intellibus Academy.
  Your job is to help users find training content on any topic, delivered
  in whatever way fits how they learn.
  Always greet warmly, then find out what topic or subject they want to
  learn about, then call find_topic with that topic.
  Never ask which format they want — the format is decided automatically
  by their stored learning style, not by you.`
});

// ---------- commands ----------

bot.onCommand("start", async (ctx) => {
  const style = await getUserStyle(ctx.sender);

  if (!style) {
    await promptLearningStyle(
      ctx,
      "👋 Welcome to Intellibus Academy! Before we start, how do you learn best?"
    );
    return;
  }

  await ctx.sendChoices(
    `👋 Welcome back! You're set up for *${style}* learning. What would you like to do?`,
    [
      { label: "🎓 Find course content",   value: "/findcourse" },
      { label: "💡 Suggest a topic",       value: "/suggest"    },
      { label: "🔀 Change learning style", value: "/style"      },
      { label: "❓ Help",                   value: "/help"       }
    ]
  );
});

bot.onCommand("style", async (ctx) => {
  await promptLearningStyle(ctx, "How do you learn best?");
});

bot.onCommand("setstyle", async (ctx) => {
  const style = ctx.args[0];

  if (!LEARNING_STYLES.includes(style)) {
    await ctx.sendText("Sorry, I didn't recognize that learning style. Type /style to try again.");
    return;
  }

  await setUserStyle(ctx.sender, style);

  const blurb = {
    audio:       "🎧 Got it — I'll go straight to audio content for whatever you want to learn.",
    visual:      "👀 Got it — I'll let you pick between infographics, videos, and slide decks.",
    kinesthetic: "🤸 Got it — I'll point you to hands-on flashcards and quizzes on the Intellibus platform."
  }[style];

  await ctx.sendChoices(
    `${blurb}\n\nWhat would you like to learn about?`,
    [{ label: "🎓 Find course content", value: "/findcourse" }]
  );
});

bot.onCommand("findcourse", async (ctx) => {
  const style = await getUserStyle(ctx.sender);
  if (!style) {
    await promptLearningStyle(ctx, "Let's set your learning style first — how do you learn best?");
    return;
  }

  await ctx.sendText(
    "What topic or subject would you like to learn about?\n\n" +
    "For example: *Project Management*, *Python Programming*, *Postman API Testing*"
  );
});

bot.onCommand("suggest", async (ctx) => {
  const { data: paths, error } = await supabase
    .from("paths")
    .select("topic, title")
    .eq("is_published", true)
    .limit(50);

  if (error || !paths || paths.length === 0) {
    await ctx.sendText("I couldn't pull up any suggestions right now — try /findcourse with a topic you already have in mind.");
    return;
  }

  const pick = paths[Math.floor(Math.random() * paths.length)];
  await handleTopicRequest(ctx, pick.topic);
});

bot.onCommand("remind", async (ctx) => {
  const topic = ctx.argText.trim();

  if (!topic) {
    await ctx.sendText("Tell me what you'd like a reminder for, e.g. `/remind CSS`");
    return;
  }

  const remindAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await ctx.scheduleNotification({
    title: "Keep learning! 📚",
    body: `Time to continue with ${topic} on Intellibus Academy.`,
    date: remindAt
  });

  await ctx.sendText(`⏰ Done! I'll remind you tomorrow to keep learning *${topic}*.`);
});

bot.onCommand("help", async (ctx) => {
  await ctx.sendText(
    "Here's what I can do:\n\n" +
    "🔹 /findcourse — find training content on any topic\n" +
    "🔹 /style — change how content is delivered to you (audio, visual, or kinesthetic)\n" +
    "🔹 /suggest — get a topic recommendation\n" +
    "🔹 /remind <topic> — get reminded tomorrow to keep learning\n\n" +
    "Just tell me what you want to learn and I'll take it from there, tailored to how you learn best."
  );
});

// all other messages - handled by the platform LLM
bot.onMessage(async (ctx) => {
  const style = await getUserStyle(ctx.sender);
  if (!style) {
    await promptLearningStyle(ctx, "Let's set your learning style first — how do you learn best?");
    return;
  }

  const turn = await ctx.think({
    tools: new Map([
      ["find_topic", {
        description: "Look up learning content once the user has named a topic or subject",
        parameters: {
          type: "object",
          properties: {
            topic: {
              type: "string",
              description: "The topic the user wants to learn about"
            }
          },
          required: ["topic"]
        },
        handler: async ({ topic }) => {
          await handleTopicRequest(ctx, topic);
          return { handled: true, topic };
        }
      }]
    ])
  });

  if (turn.reply) await ctx.sendText(turn.reply);
});

// this is the /getformat command - it fires when a visual-style user taps a format button
bot.onCommand("getformat", async (ctx) => {
  const [format, ...topicParts] = ctx.args;   // e.g. ["video", "Project", "Management"]
  const topic = topicParts.join(" ");

  if (!format || !topic) {
    await ctx.sendText("Sorry, I lost track of what you were looking for. Type /findcourse to start again.");
    return;
  }

  const result = await findCourseContent({ topic, format });

  if (result.found) {
    // result text and the next-step choices are combined into one send —
    // two sends this close together would trip the SDK's 1s per-chat cooldown
    await ctx.sendChoices(
      `✅ *${result.title}*\n\n` +
      `${result.description}\n\n` +
      `📎 Access it here:\n${result.url}\n\n` +
      `What would you like to do next?`,
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
