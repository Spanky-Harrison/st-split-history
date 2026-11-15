/**
 * Split History
 *
 * Chat Completion only. SillyTavern does not let a third-party extension
 * register a new Prompt Manager marker, and the message array delivered to
 * CHAT_COMPLETION_PROMPT_READY is what actually gets sent (it must be edited
 * in place; replacing eventData.chat is ignored).
 *
 * The extension adds a normal prompt named "Recent History". Its body is a
 * sentinel. On CHAT_COMPLETION_PROMPT_READY that sentinel is replaced with the
 * most recent character reply and every message after it, and those messages
 * are removed from the Chat History block. Drag "Recent History" in the
 * Prompt Manager to choose where that tail sits.
 */
import { ensureRecentPrompt, formatHistory, PROMPT_ID, PROMPT_NAME, relocateRecentHistory, SENTINEL } from './split.js';

const SETTINGS_KEY = 'split_history';
const DEFAULT_SETTINGS = {
    enabled: false,
    wrapper: '',
};

let promptManagerModule = null;
let booted = false;

function context() {
    return SillyTavern.getContext();
}

function settings() {
    const extensionSettings = context().extensionSettings;
    if (!extensionSettings[SETTINGS_KEY]) {
        extensionSettings[SETTINGS_KEY] = { ...DEFAULT_SETTINGS };
    }
    const current = extensionSettings[SETTINGS_KEY];
    if (typeof current.enabled !== 'boolean') current.enabled = false;
    if (typeof current.wrapper !== 'string') current.wrapper = '';
    return current;
}

function extensionTemplatePrefix() {
    const parts = new URL(import.meta.url).pathname.split('/').filter(Boolean);
    const name = parts.at(-2) || 'st-split-history';
    const parent = parts.at(-3);
    return parent === 'third-party' ? `third-party/${name}` : name;
}

async function loadPromptManager() {
    if (promptManagerModule) return promptManagerModule;
    try {
        promptManagerModule = await import('../../../openai.js');
    } catch (error) {
        console.warn('[Split History] Prompt identifiers are unavailable. Falling back to message text.', error);
        promptManagerModule = { promptManager: null };
    }
    return promptManagerModule;
}

function flattenIdentified(node, out = []) {
    const items = Array.isArray(node) ? node : (node?.collection || []);
    for (const item of items) {
        if (!item) continue;
        if (Array.isArray(item.collection) && !item.role) {
            flattenIdentified(item, out);
            continue;
        }
        if (item.content || item.tool_calls) out.push(item);
    }
    return out;
}

function identifiersFor(prompt) {
    const manager = promptManagerModule?.promptManager;
    const flat = flattenIdentified(manager?.messages);
    if (!flat.length || flat.length !== prompt.length) return undefined;
    return flat.map(message => message.identifier);
}

function boundaryTexts() {
    const prompts = context().chatCompletionSettings?.prompts || [];
    const texts = [];
    for (const prompt of prompts) {
        if (!prompt || prompt.identifier === PROMPT_ID || prompt.marker) continue;
        if (typeof prompt.content === 'string' && prompt.content.trim()) texts.push(prompt.content);
    }
    return texts;
}

function softTailTexts() {
    const oai = context().chatCompletionSettings || {};
    const texts = [];
    if (typeof oai.group_nudge_prompt === 'string' && oai.group_nudge_prompt.trim()) {
        texts.push(oai.group_nudge_prompt);
    }
    if (typeof oai.send_if_empty === 'string' && oai.send_if_empty.trim()) {
        texts.push(oai.send_if_empty);
    }
    const extensionPrompts = context().extensionPrompts || {};
    for (const prompt of Object.values(extensionPrompts)) {
        if (!prompt || typeof prompt.value !== 'string' || !prompt.value.trim()) continue;
        // IN_CHAT is 1 in SillyTavern's extension_prompt_types.
        if (prompt.position === 1 || prompt.position === 'in_chat') texts.push(prompt.value);
    }
    return texts;
}

function syncPrompt({ activate }) {
    const ctx = context();
    const changed = ensureRecentPrompt(ctx.chatCompletionSettings, {
        extensionEnabled: settings().enabled,
        activate,
        sentinel: SENTINEL,
    });
    if (changed && typeof ctx.saveSettingsDebounced === 'function') {
        ctx.saveSettingsDebounced();
    }
}

/**
 * @param {{chat: object[], dryRun?: boolean}} eventData
 */
function onPromptReady(eventData) {
    try {
        if (!settings().enabled) return;
        if (!eventData || !Array.isArray(eventData.chat)) return;

        const ctx = context();
        const oai = ctx.chatCompletionSettings || {};
        const history = formatHistory(ctx.chat, {
            namesBehavior: oai.names_behavior,
            userName: ctx.name1,
            isGroup: !!ctx.groupId,
        });

        const result = relocateRecentHistory(eventData.chat, {
            history,
            identifiers: identifiersFor(eventData.chat),
            sentinel: SENTINEL,
            wrapper: settings().wrapper,
            boundaryTexts: boundaryTexts(),
            softTailTexts: softTailTexts(),
        });

        if (result.action === 'moved') {
            console.debug(`[Split History] Moved ${result.partB.length} recent message(s) to "${PROMPT_NAME}".`);
        } else if (result.action === 'stripped') {
            console.debug(`[Split History] Left history in place (${result.reason}).`);
        }
    } catch (error) {
        console.error('[Split History] Failed to rewrite the prompt. Sending it unchanged.', error);
    }
}

function bindSettings(root) {
    const enabled = root.querySelector('#split_history_enabled');
    const wrapper = root.querySelector('#split_history_wrapper');
    const current = settings();
    enabled.checked = current.enabled;
    wrapper.value = current.wrapper;

    enabled.addEventListener('change', () => {
        settings().enabled = enabled.checked;
        context().saveSettingsDebounced();
        syncPrompt({ activate: enabled.checked });
    });

    wrapper.addEventListener('input', () => {
        settings().wrapper = wrapper.value;
        context().saveSettingsDebounced();
    });
}

async function renderSettings() {
    const ctx = context();
    const html = await ctx.renderExtensionTemplateAsync(extensionTemplatePrefix(), 'settings');
    const host = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!host) return;
    host.insertAdjacentHTML('beforeend', html);
    const root = document.getElementById('split_history_settings');
    if (root) bindSettings(root);
}

async function boot() {
    if (booted) return;
    booted = true;
    settings();
    await loadPromptManager();

    const ctx = context();
    const events = ctx.eventTypes || ctx.event_types;
    ctx.eventSource.on(events.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    ctx.eventSource.on(events.GENERATION_STARTED, () => {
        syncPrompt({ activate: false });
        // Run after other extensions that also edit this array and registered at startup.
        if (typeof ctx.eventSource.makeLast === 'function') {
            ctx.eventSource.makeLast(events.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
        }
    });
    if (events.OAI_PRESET_CHANGED_AFTER) {
        ctx.eventSource.on(events.OAI_PRESET_CHANGED_AFTER, () => syncPrompt({ activate: false }));
    }
    ctx.eventSource.on(events.SETTINGS_LOADED, () => syncPrompt({ activate: false }));

    try {
        await renderSettings();
    } catch (error) {
        console.error('[Split History] Settings panel failed to render.', error);
    }
    syncPrompt({ activate: false });
}

boot().catch(error => {
    console.error('[Split History] Failed to start.', error);
});
