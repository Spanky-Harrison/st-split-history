import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import test from 'node:test';

import {
    SENTINEL,
    PROMPT_ID,
    formatHistory,
    relocateRecentHistory,
    ensureRecentPrompt,
} from '../split.js';

const IGNORE = Symbol.for('ignore');

function line(role, content, identifier, extra = {}) {
    return { role, content, ...(identifier ? { identifier } : {}), ...extra };
}

function texts(messages) {
    return messages.map(message => {
        const name = message.name ? `${message.name}: ` : '';
        return `${message.role}:${name}${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`;
    });
}

/**
 * Default Chat Completion shape: main, start-of-chat, history, post-history, Recent History sentinel.
 * @param {{role: string, content: string}[]} history
 * @param {object[]} [tail]
 */
function promptWithHistory(history, tail = []) {
    return [
        line('system', 'Write the next reply.', 'main'),
        line('system', '[Start a new Chat]', 'newMainChat'),
        ...history.map((message, index) => line(message.role, message.content, `chatHistory-${index + 1}`, message.name ? { name: message.name } : {})),
        line('system', 'Post-history instructions.', 'jailbreak'),
        line('user', SENTINEL, PROMPT_ID),
        ...tail,
    ];
}

function historyOf(...rolesAndText) {
    const messages = [];
    for (let index = 0; index < rolesAndText.length; index += 2) {
        messages.push({ role: rolesAndText[index], content: rolesAndText[index + 1] });
    }
    return messages;
}

test('one user message after the last character reply', () => {
    const history = historyOf(
        'assistant', 'char-1',
        'user', 'user-1',
        'assistant', 'char-2',
        'user', 'user-2',
        'assistant', 'char-3',
        'user', 'user-3',
    );
    const prompt = promptWithHistory(history);
    const off = texts(prompt);

    const result = relocateRecentHistory(prompt, { history });

    assert.equal(result.action, 'moved');
    assert.deepEqual(texts(result.partB), ['assistant:char-3', 'user:user-3']);
    assert.deepEqual(texts(prompt), [
        'system:Write the next reply.',
        'system:[Start a new Chat]',
        'assistant:char-1',
        'user:user-1',
        'assistant:char-2',
        'user:user-2',
        'system:Post-history instructions.',
        'assistant:char-3',
        'user:user-3',
    ]);
    assert.notDeepEqual(off, texts(prompt));
    assert.equal(off.filter(line => line.includes(SENTINEL)).length, 1);
});

test('several messages after the last character reply, not a fixed count of two', () => {
    const history = historyOf(
        'assistant', 'char-1',
        'user', 'user-1',
        'assistant', 'char-2',
        'user', 'user-2',
        'user', 'user-3',
        'system', 'The lamp flickers.',
        'user', 'user-4',
    );
    // The narrator line is part of history, so give it a chat-history id via promptWithHistory.
    const prompt = promptWithHistory(history);
    const result = relocateRecentHistory(prompt, { history });

    assert.equal(result.action, 'moved');
    assert.equal(result.partB.length, 5);
    assert.notEqual(result.partB.length, 2);
    assert.deepEqual(texts(result.partB), [
        'assistant:char-2',
        'user:user-2',
        'user:user-3',
        'system:The lamp flickers.',
        'user:user-4',
    ]);
    assert.deepEqual(texts(prompt).slice(2, 4), ['assistant:char-1', 'user:user-1']);
});

test('no messages after the last character reply', () => {
    const history = historyOf(
        'assistant', 'char-1',
        'user', 'user-1',
        'assistant', 'char-2',
    );
    const prompt = promptWithHistory(history);
    const result = relocateRecentHistory(prompt, { history });

    assert.equal(result.action, 'moved');
    assert.deepEqual(texts(result.partB), ['assistant:char-2']);
    assert.deepEqual(texts(prompt), [
        'system:Write the next reply.',
        'system:[Start a new Chat]',
        'assistant:char-1',
        'user:user-1',
        'system:Post-history instructions.',
        'assistant:char-2',
    ]);
});

test('swipe that drops a trailing user message leaves the character reply as Part B', () => {
    const stillInChat = historyOf(
        'assistant', 'char-1',
        'user', 'user-1',
        'assistant', 'char-2',
        'user', 'user-2',
    );
    const swipedAway = { role: 'user', content: 'user-3-swiped' };
    const prompt = promptWithHistory(stillInChat);
    const result = relocateRecentHistory(prompt, { history: [...stillInChat, swipedAway] });

    assert.equal(result.action, 'moved');
    assert.deepEqual(texts(result.partB), ['assistant:char-2', 'user:user-2']);
    assert.equal(texts(prompt).includes('user:user-3-swiped'), false);
});

test('swipe of the last character reply does not copy that reply back into the prompt', () => {
    const remaining = historyOf('assistant', 'char-1', 'user', 'user-1', 'assistant', 'char-2', 'user', 'user-2');
    const prompt = promptWithHistory(remaining);
    const result = relocateRecentHistory(prompt, {
        history: [...remaining, { role: 'assistant', content: 'char-3-being-swiped' }],
    });

    assert.deepEqual(texts(result.partB), ['assistant:char-2', 'user:user-2']);
    assert.equal(JSON.stringify(prompt).includes('char-3-being-swiped'), false);
});

test('no character reply yet leaves the prompt unchanged except the sentinel is not sent', () => {
    const history = historyOf('user', 'only-user', 'user', 'still-user');
    const prompt = promptWithHistory(history);
    const result = relocateRecentHistory(prompt, { history });

    assert.equal(result.action, 'stripped');
    assert.deepEqual(result.partB, []);
    assert.equal(JSON.stringify(prompt).includes(SENTINEL), false);
    assert.deepEqual(texts(prompt).filter(item => item.startsWith('user:')), ['user:only-user', 'user:still-user']);
});

test('missing Recent History entry does not move anything', () => {
    const history = historyOf('assistant', 'char-1', 'user', 'user-1');
    const prompt = promptWithHistory(history).filter(message => message.identifier !== PROMPT_ID);
    const before = texts(prompt);
    const result = relocateRecentHistory(prompt, { history });

    assert.equal(result.action, 'unchanged');
    assert.deepEqual(texts(prompt), before);
});

test('empty wrapper adds no header; a wrapper is a system message in front of Part B', () => {
    const history = historyOf('assistant', 'char-1', 'user', 'user-1');
    const bare = promptWithHistory(history);
    relocateRecentHistory(bare, { history, wrapper: '   ' });
    assert.equal(bare.some(message => message.role === 'system' && message.content.trim() === ''), false);
    assert.equal(bare.at(-2).content, 'char-1');

    const wrapped = promptWithHistory(history);
    const result = relocateRecentHistory(wrapped, { history, wrapper: 'Focus on where the scene is now.' });
    assert.equal(result.action, 'moved');
    assert.deepEqual(texts(wrapped).slice(-3), [
        'system:Focus on where the scene is now.',
        'assistant:char-1',
        'user:user-1',
    ]);
});

test('depth injections before the last reply stay; injections in the tail move with it', () => {
    const history = historyOf('assistant', 'char-1', 'user', 'user-1', 'assistant', 'char-2', 'user', 'user-2');
    const prompt = [
        line('system', 'Write the next reply.', 'main'),
        line('system', '[Start a new Chat]', 'newMainChat'),
        line('assistant', 'char-1', 'chatHistory-1'),
        line('system', 'Old world info at depth.', 'chatHistory-2'),
        line('user', 'user-1', 'chatHistory-3'),
        line('assistant', 'char-2', 'chatHistory-4'),
        line('system', "Author's note.", 'chatHistory-5'),
        line('user', 'user-2', 'chatHistory-6'),
        line('system', 'Depth zero note.', 'chatHistory-7'),
        line('system', 'Post-history instructions.', 'jailbreak'),
        line('user', SENTINEL, PROMPT_ID),
    ];

    const result = relocateRecentHistory(prompt, { history });

    assert.deepEqual(texts(result.partB), [
        'assistant:char-2',
        "system:Author's note.",
        'user:user-2',
        'system:Depth zero note.',
    ]);
    assert.deepEqual(texts(prompt), [
        'system:Write the next reply.',
        'system:[Start a new Chat]',
        'assistant:char-1',
        'system:Old world info at depth.',
        'user:user-1',
        'system:Post-history instructions.',
        'assistant:char-2',
        "system:Author's note.",
        'user:user-2',
        'system:Depth zero note.',
    ]);
});

test('group nudge travels with the recent messages', () => {
    const history = historyOf('assistant', 'char-1', 'user', 'user-1', 'assistant', 'char-2', 'user', 'user-2');
    const prompt = [
        line('system', '[Start a new Chat]', 'newMainChat'),
        ...history.map((message, index) => line(message.role, message.content, `chatHistory-${index + 1}`)),
        line('system', '[Write the next reply only as Alice.]', 'groupNudge'),
        line('system', 'Post-history instructions.', 'jailbreak'),
        line('user', SENTINEL, PROMPT_ID),
    ];
    const result = relocateRecentHistory(prompt, { history });

    assert.equal(result.partB.at(-1).identifier, 'groupNudge');
    assert.equal(texts(prompt).at(-1), 'system:[Write the next reply only as Alice.]');
    assert.equal(texts(prompt).at(-2), 'user:user-2');
    assert.ok(texts(prompt).indexOf('system:Post-history instructions.') < texts(prompt).indexOf('assistant:char-2'));
});

test('continue prefill stays at the end of the prompt', () => {
    const history = historyOf('assistant', 'char-1', 'user', 'user-1', 'assistant', 'char-2');
    const prompt = [
        line('system', 'Write the next reply.', 'main'),
        line('system', '[Start a new Chat]', 'newMainChat'),
        line('assistant', 'char-1', 'chatHistory-1'),
        line('user', 'user-1', 'chatHistory-2'),
        line('system', 'Post-history instructions.', 'jailbreak'),
        line('user', SENTINEL, PROMPT_ID),
        line('assistant', 'char-2', 'continuePrefill'),
        line('system', '[Continue your last message without repeating its original content.]', 'continueNudge'),
    ];
    const result = relocateRecentHistory(prompt, { history });

    assert.equal(result.action, 'stripped');
    assert.deepEqual(texts(prompt).slice(-2), [
        'assistant:char-2',
        'system:[Continue your last message without repeating its original content.]',
    ]);
    assert.deepEqual(texts(prompt).slice(2, 4), ['assistant:char-1', 'user:user-1']);
    assert.equal(JSON.stringify(prompt).includes(SENTINEL), false);
});

test('a detached newest message without a continue id is also left in place', () => {
    const history = historyOf('assistant', 'char-1', 'user', 'user-1', 'assistant', 'char-2');
    const prompt = [
        line('system', '[Start a new Chat]', 'newMainChat'),
        line('assistant', 'char-1', 'chatHistory-1'),
        line('user', 'user-1', 'chatHistory-2'),
        line('system', 'Post-history instructions.', 'jailbreak'),
        line('user', SENTINEL, PROMPT_ID),
        line('assistant', 'char-2'),
    ];
    const result = relocateRecentHistory(prompt, { history });
    assert.equal(result.action, 'stripped');
    assert.equal(prompt.at(-1).content, 'char-2');
    assert.equal(prompt.some(message => message.content === 'user-1' && prompt.indexOf(message) < 3), true);
});

test('impersonate keeps its control prompt after the relocated tail', () => {
    const history = historyOf('assistant', 'char-1', 'user', 'user-1', 'assistant', 'char-2', 'user', 'user-2');
    const prompt = promptWithHistory(history, [
        line('system', '[Write your next reply from the point of view of the user.]', 'impersonate'),
    ]);
    const result = relocateRecentHistory(prompt, { history });

    assert.equal(result.action, 'moved');
    assert.equal(prompt.at(-1).identifier, 'impersonate');
    assert.deepEqual(texts(result.partB), ['assistant:char-2', 'user:user-2']);
    assert.ok(texts(prompt).indexOf('assistant:char-2') < texts(prompt).length - 1);
});

test('group chat uses the latest character reply, whichever member said it', () => {
    const chat = [
        { name: 'Alice', is_user: false, mes: 'The gate is shut.' },
        { name: 'You', is_user: true, mes: 'Can we leave?' },
        { name: 'Bob', is_user: false, mes: 'Not yet.' },
        { name: 'You', is_user: true, mes: 'Then we wait.' },
        { name: 'You', is_user: true, mes: 'I hear footsteps.' },
    ];
    const history = formatHistory(chat, { isGroup: true, userName: 'You', namesBehavior: 0 });
    const prompt = promptWithHistory(history);
    const result = relocateRecentHistory(prompt, { history });

    assert.deepEqual(history.map(message => message.content), [
        'Alice: The gate is shut.',
        'Can we leave?',
        'Bob: Not yet.',
        'Then we wait.',
        'I hear footsteps.',
    ]);
    assert.deepEqual(result.partB.map(message => message.content), [
        'Bob: Not yet.',
        'Then we wait.',
        'I hear footsteps.',
    ]);
});

test('hidden and system messages are not part of either side, and narrator lines are not character replies', () => {
    const chat = [
        { name: 'Alice', is_user: false, mes: 'Hello.' },
        { name: 'You', is_user: true, mes: 'secret aside', extra: { [IGNORE]: true } },
        { name: 'System', is_user: false, is_system: true, mes: 'Help text.' },
        { name: 'You', is_user: true, mes: 'Hi.' },
        { name: 'Alice', is_user: false, mes: 'Look.' },
        { name: 'Narrator', is_user: false, mes: 'The door opens.', extra: { type: 'narrator' } },
    ];
    const history = formatHistory(chat, { userName: 'You', namesBehavior: 0 });
    assert.equal(chat[1].mes, 'secret aside');
    assert.equal(chat[1].extra[IGNORE], true);
    assert.equal(chat[2].mes, 'Help text.');
    assert.equal(chat[5].mes, 'The door opens.');

    assert.deepEqual(history.map(message => `${message.role}:${message.content}`), [
        'assistant:Hello.',
        'user:Hi.',
        'assistant:Look.',
        'system:The door opens.',
    ]);

    const prompt = promptWithHistory(history);
    const result = relocateRecentHistory(prompt, { history });
    assert.deepEqual(result.partB.map(message => `${message.role}:${message.content}`), [
        'assistant:Look.',
        'system:The door opens.',
    ]);
    assert.equal(JSON.stringify(prompt).includes('secret aside'), false);
    assert.equal(JSON.stringify(prompt).includes('Help text'), false);
});

test('image messages move as the same object, matched on their text', () => {
    const history = historyOf('assistant', 'char-1', 'user', 'See this');
    const image = {
        role: 'user',
        content: [{ type: 'text', text: 'See this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,qq' } }],
        identifier: 'chatHistory-2',
    };
    const prompt = [
        line('system', '[Start a new Chat]', 'newMainChat'),
        line('assistant', 'char-1', 'chatHistory-1'),
        image,
        line('system', 'Post-history instructions.', 'jailbreak'),
        line('user', SENTINEL, PROMPT_ID),
    ];
    const result = relocateRecentHistory(prompt, { history });
    assert.equal(result.partB[1], image);
    assert.equal(prompt.at(-1), image);
});

test('repeated lines are split on the latest character reply', () => {
    const history = historyOf('user', 'Hi', 'assistant', 'Ok', 'user', 'Hi');
    const prompt = promptWithHistory(history);
    const result = relocateRecentHistory(prompt, { history });
    assert.deepEqual(texts(result.partB), ['assistant:Ok', 'user:Hi']);
    assert.deepEqual(texts(prompt).slice(2, 3), ['user:Hi']);
    assert.equal(texts(prompt).filter(item => item === 'user:Hi').length, 2);
});

test('the edit is in place so SillyTavern sends the same array', () => {
    const history = historyOf('assistant', 'char-1', 'user', 'user-1');
    const prompt = promptWithHistory(history);
    const same = prompt;
    relocateRecentHistory(prompt, { history });
    assert.equal(prompt, same);
    assert.equal(prompt.some(message => message.content === SENTINEL), false);
});

test('Recent History is inserted after post-history instructions and stays where it is dragged', () => {
    const settings = {
        prompts: [
            { identifier: 'main', name: 'Main Prompt', content: 'Main' },
            { identifier: 'chatHistory', name: 'Chat History', marker: true },
            { identifier: 'jailbreak', name: 'Post-History Instructions', content: 'After' },
        ],
        prompt_order: [{
            character_id: 100001,
            order: [
                { identifier: 'main', enabled: true },
                { identifier: 'chatHistory', enabled: true },
                { identifier: 'jailbreak', enabled: true },
            ],
        }],
    };

    assert.equal(ensureRecentPrompt(settings, { extensionEnabled: false }), false);
    assert.equal(settings.prompts.some(prompt => prompt.identifier === PROMPT_ID), false);

    assert.equal(ensureRecentPrompt(settings, { extensionEnabled: true, activate: true }), true);
    assert.deepEqual(settings.prompt_order[0].order.map(entry => entry.identifier), [
        'main',
        'chatHistory',
        'jailbreak',
        PROMPT_ID,
    ]);
    assert.equal(settings.prompts.find(prompt => prompt.identifier === PROMPT_ID).content, SENTINEL);
    assert.equal(settings.prompts.find(prompt => prompt.identifier === PROMPT_ID).role, 'user');

    settings.prompt_order[0].order = [
        { identifier: 'main', enabled: true },
        { identifier: PROMPT_ID, enabled: true },
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'jailbreak', enabled: true },
    ];
    ensureRecentPrompt(settings, { extensionEnabled: true, activate: false });
    assert.deepEqual(settings.prompt_order[0].order.map(entry => entry.identifier), [
        'main',
        PROMPT_ID,
        'chatHistory',
        'jailbreak',
    ]);

    settings.prompt_order[0].order.find(entry => entry.identifier === PROMPT_ID).enabled = false;
    ensureRecentPrompt(settings, { extensionEnabled: true, activate: false });
    assert.equal(settings.prompt_order[0].order.find(entry => entry.identifier === PROMPT_ID).enabled, false);

    ensureRecentPrompt(settings, { extensionEnabled: false });
    assert.equal(settings.prompt_order[0].order.find(entry => entry.identifier === PROMPT_ID).enabled, false);
    assert.equal(settings.prompts.find(prompt => prompt.identifier === PROMPT_ID).content, '');
});

test('prompt dump: extension off versus on for the canonical scene', () => {
    const history = historyOf(
        'assistant', 'The market is closing.',
        'user', 'We should go.',
        'assistant', 'One more stall.',
        'user', 'Which one?',
        'assistant', 'The one with the red awning.',
        'user', 'I am already walking.',
    );
    const off = promptWithHistory(history);
    const on = promptWithHistory(history);
    const moved = relocateRecentHistory(on, { history, wrapper: '' });

    const dump = [
        'SillyTavern chat-completion prompt, simulated from the 1.19 assembly order.',
        'History: char, user, char, user, char, user.',
        'Part A is everything before the last character reply. Part B is that reply plus whatever follows it.',
        '',
        'OFF (Recent History entry disabled, sentinel not in the prompt)',
        ...texts(off.filter(message => message.content !== SENTINEL)).map((line, index) => `${index}. ${line}`),
        '',
        `ON (${moved.reason})`,
        ...texts(on).map((line, index) => `${index}. ${line}`),
        '',
        'Part B messages:',
        ...texts(moved.partB).map(line => `- ${line}`),
        '',
    ].join('\n');

    mkdirSync(new URL('./dumps/', import.meta.url), { recursive: true });
    writeFileSync(new URL('./dumps/canonical.txt', import.meta.url), dump);

    assert.match(dump, /0\. system:Write the next reply\./);
    assert.match(dump, /ON \(recent history moved onto its prompt entry\)/);
    assert.match(dump, /7\. assistant:The one with the red awning\./);
    assert.match(dump, /8\. user:I am already walking\./);
    const onLines = dump.split('ON')[1];
    assert.ok(onLines.indexOf('Which one?') < onLines.indexOf('Post-history instructions.'));
    assert.ok(onLines.indexOf('Post-history instructions.') < onLines.indexOf('The one with the red awning.'));
});
