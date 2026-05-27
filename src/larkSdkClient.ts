import { createReadStream } from 'node:fs';

import * as lark from '@larksuiteoapi/node-sdk';

import type { AssistantConfig } from './types.js';
import type { LarkClientPort, LarkIncomingMessage } from './larkBridge.js';

interface LarkApiClient {
  im: {
    v1: {
      chat: {
        create(payload: unknown): Promise<{ code?: number; msg?: string; data?: { chat_id?: string } }>;
      };
      file: {
        create(payload: unknown): Promise<{ file_key?: string } | null>;
      };
      message: {
        create(payload: unknown): Promise<{ code?: number; msg?: string }>;
      };
    };
  };
}

interface LarkWsClient {
  start(input: { eventDispatcher: unknown }): void;
}

export class LarkSdkClient implements LarkClientPort {
  private readonly client: LarkApiClient;
  private readonly wsClient: LarkWsClient;

  constructor(config: AssistantConfig, env: NodeJS.ProcessEnv = process.env) {
    const appId = env[config.lark.appIdEnv]?.trim();
    const appSecret = env[config.lark.appSecretEnv]?.trim();
    if (!appId || !appSecret) {
      throw new Error(`${config.lark.appIdEnv} and ${config.lark.appSecretEnv} are required for Lark bridge.`);
    }

    const domain = config.lark.platform === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;
    const baseConfig = {
      appId,
      appSecret,
      domain,
      appType: lark.AppType.SelfBuild,
      loggerLevel: lark.LoggerLevel.warn,
      source: 'vibecodingassistant-elonma',
    };
    this.client = new lark.Client(baseConfig) as unknown as LarkApiClient;
    this.wsClient = new lark.WSClient(baseConfig) as unknown as LarkWsClient;
  }

  async start(onMessage: (message: LarkIncomingMessage) => void | Promise<void>): Promise<void> {
    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        const message = parseIncomingMessage(data);
        if (message) await onMessage(message);
      },
    });
    this.wsClient.start({ eventDispatcher });
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const result = await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: trimForLark(text) }),
      },
    });
    assertOk(result, 'send Lark message');
  }

  async sendFile(chatId: string, file: { path: string; name: string }): Promise<void> {
    const upload = await this.client.im.v1.file.create({
      data: {
        file_type: 'stream',
        file_name: file.name,
        file: createReadStream(file.path),
      },
    });
    const fileKey = upload?.file_key;
    if (!fileKey) throw new Error(`Lark file upload did not return file_key for ${file.path}.`);

    const result = await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
      },
    });
    assertOk(result, 'send Lark file');
  }

  async createTaskChat(input: { name: string; memberOpenIds: string[] }): Promise<string> {
    const result = await this.client.im.v1.chat.create({
      params: { user_id_type: 'open_id' },
      data: {
        name: trimForLark(input.name, 80),
        chat_mode: 'group',
        chat_type: 'private',
        group_message_type: 'chat',
        user_id_list: input.memberOpenIds,
      },
    });
    assertOk(result, 'create Lark task chat');
    const chatId = result.data?.chat_id;
    if (!chatId) throw new Error('Lark chat create did not return chat_id.');
    return chatId;
  }
}

export function parseIncomingMessage(data: unknown): LarkIncomingMessage | undefined {
  const root = record(data);
  const message = record(root.message);
  const sender = record(root.sender);
  const senderId = record(sender.sender_id);
  const chatId = stringValue(message.chat_id);
  const messageId = stringValue(message.message_id);
  const senderOpenId = stringValue(senderId.open_id);
  const content = parseContent(stringValue(message.content));
  if (!chatId || !messageId || !senderOpenId || !content) return undefined;

  return {
    eventId: stringValue(root.event_id) ?? messageId,
    messageId,
    chatId,
    senderOpenId,
    text: content,
  };
}

function parseContent(content: string | undefined): string | undefined {
  if (!content) return undefined;
  try {
    const payload = JSON.parse(content) as unknown;
    const text = stringValue(record(payload).text);
    return stripLarkMentions(text ?? '').trim() || undefined;
  } catch {
    return stripLarkMentions(content).trim() || undefined;
  }
}

export function stripLarkMentions(text: string): string {
  return text.replace(/@_user_\d+|<at[^>]*>.*?<\/at>|@\S+/g, ' ').replace(/\s+/g, ' ').trim();
}

function assertOk(result: { code?: number; msg?: string } | null, action: string): void {
  if (result && (result.code === undefined || result.code === 0)) return;
  throw new Error(`Failed to ${action}: ${result?.msg ?? 'unknown Lark API error'}`);
}

function trimForLark(text: string, maxLength = 3900): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}...`;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
