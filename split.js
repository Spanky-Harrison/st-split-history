/**
 * Pure prompt-split helpers for the Split History extension.
 *
 * SillyTavern's Chat Completion prompt is an array of {role, content} messages.
 * Chat History is one contiguous block. This module moves the tail of that
 * block (the most recent assistant reply and everything after it) onto a
 * sentinel prompt the user can drag in the Prompt Manager.
 *
 * It never writes to the chat file. Callers pass a copy of the assembled
 * prompt and a read-only view of the chat messages that belong in history.
 */

export const PROMPT_ID = 'splitHistoryRecent';
export const PROMPT_NAME = 'Recent History';

/** Visible placeholder. Replaced before the request is sent. Role is "user" so SillyTavern's system-message squash does not merge it. */
export const SENTINEL = '[[st-split-history:recent]]';

/** Identifiers SillyTavern uses when it has already lifted the message being continued out of Chat History. */
export const CONTINUE_IDENTIFIERS = ['continueNudge', 'continuePrefill'];

export const NAMES_BEHAVIOR = {
    NONE: -1,
    DEFAULT: 0,
    COMPLETION: 1,
    CONTENT: 2,
};

const NARRATOR = 'narrator';

/**
 * @param {unknown} message
 * @returns {string}
 */
export function messageText(message) {
    const content = message && typeof message === 'object' ? message.content : '';
    if (typeof content === 'string') {
        return content.replace(/\r/g, '');
    }
    if (Array.isArray(content)) {
        return content
            .map(part => {
                if (typeof part === 'string') return part;
                if (part && typeof part.text === 'string') return part.text;
                return '';
            })
            .join('');
    }
    return '';
}

/**
 * @param {string|undefined} identifier
 * @returns {boolean}
 */
export function isHistoryIdentifier(identifier) {
    if (!identifier) return false;
    return identifier === 'newMainChat'
        || identifier === 'groupNudge'
        || identifier === 'emptyUserMessageReplacement'
        || identifier.startsWith('chatHistory-')
        || identifier.startsWith('toolCall-');
}

/**
 * Messages SillyTavern would actually place in Chat History.
 * System UI messages and hidden messages are omitted. Narrator lines stay,
 * with role "system", and do not count as character replies.
 *
 * @param {object[]} chat
 * @param {object} [options]
 * @param {number} [options.namesBehavior]
 * @param {string} [options.userName]
 * @param {boolean} [options.isGroup]
 * @returns {{role: string, content: string, name?: string}[]}
 */
export function formatHistory(chat, options = {}) {
    const namesBehavior = options.namesBehavior ?? NAMES_BEHAVIOR.DEFAULT;
    const userName = options.userName ?? '';
    const isGroup = !!options.isGroup;
    const ignoreSymbol = Symbol.for('ignore');
    const formatted = [];

    for (const message of chat || []) {
        if (!message || typeof message !== 'object') continue;
        const extra = message.extra && typeof message.extra === 'object' ? message.extra : {};
        const hidden = extra[ignoreSymbol] || extra.ignore === true;
        const toolInvocations = Array.isArray(extra.tool_invocations);
        if (hidden) continue;
        if (message.is_system && !toolInvocations) continue;

        const isNarrator = extra.type === NARRATOR;
        let role = message.is_user ? 'user' : 'assistant';
        if (isNarrator) role = 'system';

        let content = String(message.mes ?? '').replace(/\r/g, '');
        const name = typeof message.name === 'string' ? message.name : '';
        const prefixName = namesBehavior === NAMES_BEHAVIOR.CONTENT
            ? !isNarrator && name
            : namesBehavior === NAMES_BEHAVIOR.DEFAULT
                && ((isGroup && name && name !== userName) || (message.force_avatar && name && name !== userName && !isNarrator));

        if (prefixName) {
            content = `${name}: ${content}`;
        }

        formatted.push({ role, content, ...(name ? { name } : {}) });
    }

    return formatted;
}

/**
 * @param {object} promptMessage
 * @param {{role: string, content: string, name?: string}} historyMessage
 * @returns {boolean}
 */
function sameHistoryMessage(promptMessage, historyMessage) {
    if (!promptMessage || !historyMessage) return false;
    if (promptMessage.role !== historyMessage.role) return false;
    // Content is compared after name prefixes are applied. The API name field is
    // not compared: Completion mode sanitizes it, and other modes omit it.
    return messageText(promptMessage) === historyMessage.content;
}

/**
 * @param {Iterable<string>|undefined} values
 * @returns {Set<string>}
 */
function asSet(values) {
    if (!values) return new Set();
    if (values instanceof Set) return values;
    return new Set(values);
}

/**
 * @param {object[]} prompt
 * @param {(string|undefined)[]} identifiers
 * @param {Set<number>} sentinelIndexes
 * @param {{role: string, content: string, name?: string}[]} history
 * @param {Set<string>} boundaryTexts
 * @returns {number[]} prompt index for each history message, or -1
 */
function alignHistory(prompt, identifiers, sentinelIndexes, history, boundaryTexts) {
    const indices = new Array(history.length).fill(-1);
    let cursor = prompt.length - 1;

    for (let historyIndex = history.length - 1; historyIndex >= 0; historyIndex--) {
        let found = -1;
        for (let promptIndex = cursor; promptIndex >= 0; promptIndex--) {
            if (sentinelIndexes.has(promptIndex)) continue;
            const identifier = identifiers[promptIndex];
            if (identifier && !isHistoryIdentifier(identifier)) continue;
            const text = messageText(prompt[promptIndex]);
            if (!identifier && boundaryTexts.has(text)) continue;
            if (sameHistoryMessage(prompt[promptIndex], history[historyIndex])) {
                found = promptIndex;
                break;
            }
        }
        if (found >= 0) {
            indices[historyIndex] = found;
            cursor = found - 1;
        }
    }

    return indices;
}

/**
 * @param {object[]} prompt
 * @param {(string|undefined)[]} identifiers
 * @param {number} from exclusive
 * @param {number} to exclusive
 * @param {Set<number>} sentinelIndexes
 * @param {Set<string>} boundaryTexts
 * @returns {boolean}
 */
function gapBreaksCluster(prompt, identifiers, from, to, sentinelIndexes, boundaryTexts) {
    for (let index = from + 1; index < to; index++) {
        if (sentinelIndexes.has(index)) return true;
        const identifier = identifiers[index];
        if (identifier && !isHistoryIdentifier(identifier)) return true;
        if (!identifier && boundaryTexts.has(messageText(prompt[index]))) return true;
    }
    return false;
}

/**
 * @param {object} message
 * @param {string|undefined} identifier
 * @param {Set<string>} softTailTexts
 * @returns {boolean}
 */
function isSoftTail(message, identifier, softTailTexts) {
    if (identifier === 'groupNudge' || identifier === 'emptyUserMessageReplacement') return true;
    if (typeof identifier === 'string' && (identifier.startsWith('chatHistory-') || identifier.startsWith('toolCall-'))) {
        return true;
    }
    return softTailTexts.has(messageText(message));
}

/**
 * Move Part B onto the sentinel, in place.
 *
 * Part A is every history message before the most recent assistant reply that
 * is still inside the Chat History block. Part B is that reply plus every
 * prompt message after it in the block (later user messages, narrator lines,
 * depth injections that landed in the tail, the group nudge). The length of
 * Part B is not fixed.
 *
 * No assistant reply in the block, or an empty Part B: the sentinel is removed
 * and nothing is inserted. Continue prefill / continue nudge: the prompt is
 * left in SillyTavern's order and only the sentinel is removed.
 *
 * @param {object[]} prompt assembled chat-completion messages. Mutated in place.
 * @param {object} options
 * @param {{role: string, content: string, name?: string}[]} options.history
 * @param {(string|undefined)[]} [options.identifiers] parallel to prompt, when known
 * @param {string} [options.sentinel]
 * @param {string} [options.wrapper]
 * @param {Iterable<string>} [options.boundaryTexts] other prompt bodies that must not be treated as chat
 * @param {Iterable<string>} [options.softTailTexts] depth injections and nudges that travel with the tail
 * @param {string[]} [options.abortIdentifiers]
 * @returns {{action: 'unchanged'|'stripped'|'moved', reason: string, partB: object[]}}
 */
export function relocateRecentHistory(prompt, options) {
    const history = options.history || [];
    const sentinel = options.sentinel ?? SENTINEL;
    const wrapper = typeof options.wrapper === 'string' ? options.wrapper : '';
    const identifiers = Array.isArray(options.identifiers) && options.identifiers.length === prompt.length
        ? options.identifiers
        : prompt.map(message => message?.identifier);
    const boundaryTexts = asSet(options.boundaryTexts);
    const softTailTexts = asSet(options.softTailTexts);
    const abortIdentifiers = new Set(options.abortIdentifiers || CONTINUE_IDENTIFIERS);

    const sentinelIndexes = new Set();
    prompt.forEach((message, index) => {
        if (messageText(message) === sentinel) sentinelIndexes.add(index);
    });

    if (sentinelIndexes.size === 0) {
        return { action: 'unchanged', reason: 'recent-history prompt is not in this request', partB: [] };
    }

    const sentinelIndex = Math.min(...sentinelIndexes);

    const abort = prompt.some((message, index) => {
        const identifier = identifiers[index];
        return (identifier && abortIdentifiers.has(identifier))
            || (typeof message?.identifier === 'string' && abortIdentifiers.has(message.identifier));
    });

    const finish = (action, reason, partB, next) => {
        prompt.splice(0, prompt.length, ...next);
        return { action, reason, partB };
    };

    const withoutSentinel = () => prompt.filter((_, index) => !sentinelIndexes.has(index));

    if (abort) {
        return finish('stripped', 'continue already placed the reply being extended', [], withoutSentinel());
    }

    if (!history.length) {
        return finish('stripped', 'no chat history in the prompt', [], withoutSentinel());
    }

    const aligned = alignHistory(prompt, identifiers, sentinelIndexes, history, boundaryTexts);
    const matched = aligned
        .map((promptIndex, historyIndex) => ({ promptIndex, historyIndex }))
        .filter(item => item.promptIndex >= 0);

    if (!matched.length) {
        return finish('stripped', 'chat history could not be lined up with the prompt', [], withoutSentinel());
    }

    const clusters = [];
    let current = null;
    for (const item of matched) {
        if (!current || gapBreaksCluster(prompt, identifiers, current.end, item.promptIndex, sentinelIndexes, boundaryTexts)) {
            current = { start: item.promptIndex, end: item.promptIndex, items: [item] };
            clusters.push(current);
        } else {
            current.end = item.promptIndex;
            current.items.push(item);
        }
    }

    const historyCluster = clusters.reduce((best, cluster) => {
        if (!best || cluster.items.length > best.items.length) return cluster;
        return best;
    }, null);

    // Continue without a recognizable nudge id still parks the message being
    // extended after the history block. Leave SillyTavern's order alone.
    const newestMatched = aligned[history.length - 1];
    if (newestMatched >= 0 && (newestMatched < historyCluster.start || newestMatched > historyCluster.end)) {
        return finish('stripped', 'the newest message sits outside chat history', [], withoutSentinel());
    }

    let splitAt = -1;
    for (const item of historyCluster.items) {
        if (history[item.historyIndex].role === 'assistant') {
            splitAt = item.promptIndex;
        }
    }

    if (splitAt < 0) {
        return finish('stripped', 'no character reply in the chat history block', [], withoutSentinel());
    }

    let end = historyCluster.end;
    while (end + 1 < prompt.length && !sentinelIndexes.has(end + 1)) {
        const identifier = identifiers[end + 1];
        if (identifier && !isHistoryIdentifier(identifier)) break;
        if (!isSoftTail(prompt[end + 1], identifier, softTailTexts)) break;
        end++;
    }

    const partBIndexes = [];
    for (let index = splitAt; index <= end; index++) {
        if (sentinelIndexes.has(index)) continue;
        partBIndexes.push(index);
    }

    if (!partBIndexes.length) {
        return finish('stripped', 'recent part is empty', [], withoutSentinel());
    }

    const partB = partBIndexes.map(index => prompt[index]);
    const moved = new Set(partBIndexes);
    const header = wrapper.trim() ? [{ role: 'system', content: wrapper }] : [];
    const next = [];

    for (let index = 0; index < prompt.length; index++) {
        if (index === sentinelIndex) {
            next.push(...header, ...partB);
            continue;
        }
        if (sentinelIndexes.has(index) || moved.has(index)) continue;
        next.push(prompt[index]);
    }

    return finish('moved', 'recent history moved onto its prompt entry', partB, next);
}

/**
 * Add or update the draggable Recent History prompt on a Chat Completion preset.
 * Does not reorder an entry the user has already placed.
 *
 * @param {object} settings oai / chat completion settings
 * @param {object} [options]
 * @param {boolean} [options.extensionEnabled]
 * @param {boolean} [options.activate] turn the prompt on (when the user enables the extension)
 * @param {string} [options.sentinel]
 * @returns {boolean} true when settings changed
 */
export function ensureRecentPrompt(settings, options = {}) {
    if (!settings || typeof settings !== 'object') return false;

    const extensionEnabled = !!options.extensionEnabled;
    const activate = !!options.activate;
    const sentinel = options.sentinel ?? SENTINEL;
    let changed = false;

    if (!Array.isArray(settings.prompts)) {
        if (!extensionEnabled) return false;
        settings.prompts = [];
        changed = true;
    }

    let prompt = settings.prompts.find(item => item && item.identifier === PROMPT_ID);
    if (!prompt && !extensionEnabled) {
        return changed;
    }
    if (!prompt) {
        prompt = {
            identifier: PROMPT_ID,
            name: PROMPT_NAME,
            role: 'user',
            content: '',
            system_prompt: true,
            marker: false,
            injection_position: 0,
            injection_depth: 4,
            injection_order: 100,
            forbid_overrides: true,
        };
        settings.prompts.push(prompt);
        changed = true;
    }

    const content = extensionEnabled ? sentinel : '';
    if (prompt.content !== content) {
        prompt.content = content;
        changed = true;
    }
    if (prompt.role !== 'user') {
        prompt.role = 'user';
        changed = true;
    }
    if (prompt.marker) {
        prompt.marker = false;
        changed = true;
    }
    if (!prompt.name) {
        prompt.name = PROMPT_NAME;
        changed = true;
    }

    if (!Array.isArray(settings.prompt_order)) {
        settings.prompt_order = [];
        changed = true;
    }
    if (settings.prompt_order.length === 0) {
        settings.prompt_order.push({ character_id: 100001, order: [] });
        changed = true;
    }

    for (const list of settings.prompt_order) {
        if (!list || !Array.isArray(list.order)) continue;
        let entry = list.order.find(item => item && item.identifier === PROMPT_ID);
        if (!entry) {
            entry = { identifier: PROMPT_ID, enabled: extensionEnabled };
            const jailbreakAt = list.order.findIndex(item => item && item.identifier === 'jailbreak');
            if (jailbreakAt >= 0) list.order.splice(jailbreakAt + 1, 0, entry);
            else list.order.push(entry);
            changed = true;
        } else if (!extensionEnabled && entry.enabled) {
            entry.enabled = false;
            changed = true;
        } else if (activate && extensionEnabled && !entry.enabled) {
            entry.enabled = true;
            changed = true;
        }
    }

    return changed;
}
