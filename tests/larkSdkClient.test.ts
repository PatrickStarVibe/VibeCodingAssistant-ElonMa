import { describe, expect, it } from 'vitest';

import { parseIncomingMessage, stripLarkMentions } from '../src/larkSdkClient.js';

function event(content: unknown, overrides: Record<string, unknown> = {}): unknown {
  return {
    event_id: 'event-1',
    sender: { sender_id: { open_id: 'user-open-id' } },
    message: {
      message_id: 'message-1',
      chat_id: 'chat-1',
      message_type: 'text',
      content: typeof content === 'string' ? content : JSON.stringify(content),
      ...overrides,
    },
  };
}

describe('LarkSdkClient message parsing', () => {
  it('parses private text messages', () => {
    expect(parseIncomingMessage(event({ text: 'hello' }))).toMatchObject({
      eventId: 'event-1',
      messageId: 'message-1',
      chatId: 'chat-1',
      senderOpenId: 'user-open-id',
      text: 'hello',
    });
  });

  it('parses group rich-text post messages after stripping bot mentions', () => {
    const parsed = parseIncomingMessage(event({
      zh_cn: {
        title: '',
        content: [
          [
            { tag: 'at', user_id: 'ou_bot', user_name: 'vibeCoding Assistant' },
            { tag: 'text', text: 'Use karpathy-guidelines.' },
          ],
          [
            { tag: 'text', text: 'Start testing the PDF Reader Mode parser route.' },
          ],
        ],
      },
    }, { message_type: 'post' }));

    expect(parsed?.text).toBe('Use karpathy-guidelines. Start testing the PDF Reader Mode parser route.');
  });

  it('strips renamed bot mentions without deleting the rest of the message', () => {
    expect(stripLarkMentions('@vibeCoding Assistant please check this')).toBe('please check this');
    expect(stripLarkMentions('<at user_id="ou_bot">vibeCoding Assistant</at> please check this')).toBe('please check this');
  });
});
