import { ChatClient } from "simplex-chat";
import { T } from "@simplex-chat/types";
import pino from "pino";

const log = pino({ name: "simplex-bridge" });

export interface BotConfig {
    host: string;
    port: number;
    displayName: string;
}

export class SimplexBridge {
    private chatClient: ChatClient | null = null;
    private userId: number | null = null;

    async connect(config: BotConfig): Promise<string> {
        log.info({ host: config.host, port: config.port }, "connecting");

        this.chatClient = await ChatClient.create(`ws://${config.host}:${config.port}`);

        const existingUser = await this.chatClient.apiGetActiveUser();
        if (existingUser) {
            this.userId = existingUser.userId;
            log.info({ userId: this.userId, name: existingUser.profile.displayName }, "user found");
        } else {
            const newUser = await this.chatClient.apiCreateActiveUser({
                displayName: config.displayName,
                fullName: config.displayName,
            });
            this.userId = newUser.userId;
            log.info({ userId: this.userId, displayName: config.displayName }, "user created");
        }

        const address = (await this.chatClient.apiGetUserAddress(this.userId))
            ?? (await this.chatClient.apiCreateUserAddress(this.userId));
        log.info({ address }, "bot address ready");

        await this.chatClient.enableAddressAutoAccept(this.userId);
        log.info({ userId: this.userId }, "auto-accept enabled");

        log.info({ userId: this.userId }, "connected");
        return address;
    }

    // listens for incoming messages and yields them as they arrive
    async *listen(): AsyncGenerator<{ chatId: number; message: string }, void, unknown> {
        if (!this.chatClient) {
            throw new Error("Not connected to simplex-chat");
        }

        for await (const event of this.chatClient.msgQ) {
            if (event.type === "contactConnected") {
                // Send welcome message to new contacts

                await this.reply(event.contact.contactId, `Welcome, ${event.contact.profile.displayName}!`);

                log.info(
                    { contactId: event.contact.contactId, displayName: event.contact.profile.displayName },
                    "contact connected"
                );
                continue;
            }

            if (event.type === "newChatItems") {
                for (const { chatInfo, chatItem } of event.chatItems) {
                    // Skip non-direct chats
                    if (chatInfo.type !== T.ChatType.Direct) {
                        log.debug({ chatType: chatInfo.type }, "skipping non-direct chat");
                        continue;
                    }

                    // Skip non-text content
                    if (chatItem.content.type !== "rcvMsgContent") {
                        log.debug({ contentType: chatItem.content.type }, "skipping non-text content");
                        continue;
                    }

                    const msgContent = chatItem.content.msgContent;
                    if (msgContent.type !== "text") {
                        log.debug({ contentType: msgContent.type }, "skipping non-text content");
                        continue;
                    }

                    const text = msgContent.text;
                    const preview = text.slice(0, 80);
                    log.info({ chatId: chatInfo.contact.contactId, preview }, "message received");
                    yield { chatId: chatInfo.contact.contactId, message: text };
                }
            }
        }
    }

    async reply(chatId: number, message: string): Promise<void> {
        if (!this.chatClient || !this.userId) {
            throw new Error("Not connected to simplex-chat");
        }
        try {
            await this.chatClient.apiSendTextMessage(T.ChatType.Direct, chatId, message);
            log.info({ chatId, chars: message.length }, "reply sent");
        } catch (err) {
            log.error(
                { chatId, err: err instanceof Error ? err.message : String(err) },
                "reply failed"
            );
            throw err;
        }
    }

    async disconnect(): Promise<void> {
        if (this.chatClient) {
            await this.chatClient.disconnect();
            this.chatClient = null;
            this.userId = null;
            log.info({}, "disconnected");
        }
    }
}