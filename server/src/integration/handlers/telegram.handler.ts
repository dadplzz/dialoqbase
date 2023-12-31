import { PrismaClient } from "@prisma/client";
import { embeddings } from "../../utils/embeddings";
import { DialoqbaseVectorStore } from "../../utils/store";
import { chatModelProvider } from "../../utils/models";
import { ConversationalRetrievalQAChain } from "langchain/chains";
const prisma = new PrismaClient();

export const telegramBotHandler = async (
  identifer: string,
  message: string,
  user_id: number
) => {
  try {
    const bot_id = identifer.split("-")[2];

    await prisma.$connect();

    const bot = await prisma.bot.findFirst({
      where: {
        id: bot_id,
      },
    });

    if (!bot) {
      return "Opps! Bot not found";
    }

    const chat_history = await prisma.botTelegramHistory.findMany({
      where: {
        new_chat_id: `${user_id}`,
        identifier: identifer,
      },
    });

    if (chat_history.length > 10) {
      chat_history.splice(0, chat_history.length - 10);
    }

    let history = chat_history
      .map((chat) => {
        return `Human: ${chat.human}\nAssistant: ${chat.bot}`;
      })
      .join("\n");

    const temperature = bot.temperature;

    const sanitizedQuestion = message.trim().replaceAll("\n", " ");
    const embeddingModel = embeddings(bot.embedding);

    const vectorstore = await DialoqbaseVectorStore.fromExistingIndex(
      embeddingModel,
      {
        botId: bot.id,
        sourceId: null,
      }
    );

    const modelinfo = await prisma.dialoqbaseModels.findFirst({
      where: {
        model_id: bot.model,
        hide: false,
        deleted: false,
      },
    });

    if (!modelinfo) {
      return "Unable to find model";
    }

    const botConfig: any = (modelinfo.config as {}) || {};
    if (bot.provider.toLowerCase() === "openai") {
      if (bot.bot_model_api_key && bot.bot_model_api_key.trim() !== "") {
        botConfig.configuration = {
          apiKey: bot.bot_model_api_key,
        };
      }
    }

    const model = chatModelProvider(bot.provider, bot.model, temperature, {
      ...botConfig,
    });

    const chain = ConversationalRetrievalQAChain.fromLLM(
      model,
      vectorstore.asRetriever(),
      {
        qaTemplate: bot.qaPrompt,
        questionGeneratorTemplate: bot.questionGeneratorPrompt,
        returnSourceDocuments: true,
      }
    );

    const response = await chain.call({
      question: sanitizedQuestion,
      chat_history: history,
    });

    const bot_response = response["text"];

    await prisma.botTelegramHistory.create({
      data: {
        identifier: identifer,
        new_chat_id: `${user_id}`,
        human: message,
        bot: bot_response,
      },
    });

    await prisma.$disconnect();

    return bot_response;
  } catch (error) {
    console.log(error);
    return "Opps! Something went wrong";
  }
};
