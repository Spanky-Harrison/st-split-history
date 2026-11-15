# Split History

SillyTavern extension that splits the Chat History block of a **Chat Completion** prompt into two parts, so the model can read the current scene apart from the older log.

| Part | What it contains |
| --- | --- |
| A. Chat History | Every message **before** the most recent character reply. |
| B. Recent History | That character reply, plus **every** message after it. |

Part B is not "the last two messages". One reply with one user message after it is two messages. Several user messages (or a narrator line, or anything else) after that reply all stay with it. If the reply is the last message, Part B is only that reply.

```
char, user, char, user, char, user
Part A: char, user, char, user
Part B: char, user
```

```
char, user, char, user, user, user
Part A: char, user
Part B: char, user, user, user
```

```
char, user, char
Part A: char, user
Part B: char
```

The chat file and the messages on screen are not modified. Only the prompt sent to the model changes.

## Why this approach

Current SillyTavern (1.19, default branch as of November 2026) builds Chat Completion prompts in `public/scripts/openai.js`. `chatHistory` is a hard-coded marker. A third-party extension cannot register another marker that the core fills with a run of user and assistant messages. Custom Prompt Manager entries are a single static prompt.

`CHAT_COMPLETION_PROMPT_READY` is the supported hook. Its `chat` array is the array that is actually sent. Replacing `eventData.chat` does nothing; the listener has to edit that array in place. Message identifiers are stripped before the event, so this extension also reads `promptManager.messages` when that export is available and lines the prompt up with the chat.

The practical version of a draggable entry: while the extension is on, it adds a normal prompt named **Recent History** to the active Chat Completion preset. The body is a placeholder. After SillyTavern assembles the prompt, the placeholder is replaced with Part B and those messages are removed from Chat History. Drag **Recent History** in the Prompt Manager like any other prompt. The first time it is added, it is placed just after **Post-History Instructions**, which on the default order puts the current scene after the jailbreak instead of glued to the old log.

Text Completion is left alone. That path is one combined string (`GENERATE_AFTER_COMBINE_PROMPTS`) with instruct wrappers, and it has no Prompt Manager list to drag. Moving a slice of that string would be easy to get wrong, so this extension does not change it.

## Install

1. In SillyTavern open **Extensions** and choose **Install extension**.
2. Paste the URL of this repository and install it.
3. Enable **Split History** in the extension settings.
4. Open the Chat Completion **Prompt Manager** and drag **Recent History** to where the current scene should sit.

The extension needs SillyTavern 1.13 or newer (`CHAT_COMPLETION_PROMPT_READY`). It was written against the 1.19 prompt builder.

## Use

- **Split chat history** turns the rewrite on. Off, the prompt is unchanged and the Recent History entry is disabled so its placeholder is not sent.
- **Header in front of the recent messages** is optional. Empty means no extra message. Any text is sent as one system message immediately before Part B.
- Leave the text of the Recent History prompt alone. The extension owns that body. Placement is the drag handle, the toggle in the Prompt Manager, or the in-chat depth control if you switch the entry to absolute injection.
- Turning the entry off in the Prompt Manager keeps the extension installed but stops moving messages.
- Check a generation with the prompt itemizer (the prompt icon on a message). Token counts on the Prompt Manager still attribute Part B to Chat History, because SillyTavern counts tokens before this extension runs. The itemized prompt shows the order that was sent.

## How the edges are handled

**No character reply yet.** The prompt is not reordered. The placeholder is removed so it is not sent.

**Part B would be empty** (the last character reply was trimmed out of the prompt by the token budget, or it could not be lined up). Nothing is inserted. History stays as SillyTavern built it, and the placeholder is removed.

**Group chats.** Every member's message is an assistant message. Part B starts at the latest one, whichever member said it. With the default "add names" behavior, names are prefixed the same way SillyTavern prefixes them.

**Swipes and regenerate.** SillyTavern removes the message being rewritten before it builds the prompt (a swipe pops it from the prompt copy; regenerate shortens the chat until the new reply arrives). The split sees that shorter history. The discarded reply is not copied back in. If removing it leaves a character reply at the end of history, Part B is that reply and anything still after it.

**Continue.** SillyTavern already lifts the message being continued to the end of the prompt (prefill, or the message plus the continue nudge). This extension recognizes `continuePrefill` and `continueNudge`, and also a newest chat message that landed outside the Chat History block. It then leaves SillyTavern's order as-is and only drops the placeholder, so the prefill is not pulled off the end.

**Impersonate and quiet prompts.** Those stay control prompts at the end. History is still split.

**System and hidden messages.** Messages flagged `is_system` (help, comments, and the other built-in system lines) are already dropped by SillyTavern and are not in either part. Messages hidden with the ignore flag are skipped the same way. A narrator line (`/sys`, role system) is not a character reply. It stays on whichever side of the latest character reply it was written on.

**Author's note, world info, and other depth injections.** They are injected into the history block before this extension runs. An injection before the latest character reply stays in Chat History. An injection after that reply, including depth 0 at the end of the block, moves with Part B. The group nudge moves with Part B so "write the next reply as this character" stays next to the current scene. `[Start a new Chat]` stays at the front of Chat History.

**Names, regex, and reasoning.** The extension matches prompt lines to chat text after the same name-prefix rules SillyTavern uses, and after carriage returns are stripped. If a regex script or inlined reasoning changes the text so the lines no longer match, the extension does not guess: it leaves history in place and drops the placeholder.

**Tool-call-only turns.** A character reply that SillyTavern replaced with tool-call messages may not match the original text. The split then uses the previous plain character reply, or leaves the prompt alone if none matches.

**Squash system messages.** The placeholder is a user message so it is not merged into a neighboring system prompt. Narrator lines can still be squashed into adjacent system injections; if that happens, matching can fail and the prompt is left in place.

**Other prompt-editing extensions.** This one loads late (`loading_order` 100) and edits the prompt in the ready event. An extension that edits the same array afterward can move the messages again.

## Tests

```bash
npm test
```

The tests cover one trailing user message, several trailing messages, a character reply with nothing after it, swipes, continue, impersonate, group names, hidden and system messages, narrator lines, depth injections, the group nudge, and the Prompt Manager entry. `test/dumps/canonical.txt` is the off-versus-on prompt for the six-message example.

SillyTavern itself was not booted in this environment. The rewrite is checked against a prompt laid out the way 1.19's `prepareOpenAIMessages` lays one out (main prompt, new-chat line, history, post-history instructions, then the draggable entry). The itemizer inside a running SillyTavern is the check that the live request matches.
