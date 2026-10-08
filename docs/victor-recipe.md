# OptChat recipe reference

Author: Victor Taelin.

Source: https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449

The implementation was compared with the recipe's revision `3c190e0`, fetched on 2026-10-08. The reference content SHA-256 was `12f300f760af82bc07bc5201051d1267824ded09c9def8186e4f8144368038d8`.

The source remains upstream rather than duplicating the full article here. The four prompt strings in `src/prompts.ts` come from the earlier revision `f51fe5c` (2026-10-04, SHA-256 `8f6997e8944d85e4df53b5704bf7c4e393e4da361071181e9cc2f7d9d1b6e430`), with attribution in `THIRD_PARTY_NOTICES.md`. `VIEW_DOC` and `COMPACT` also carry the `3c190e0` sentence on split text. That revision's single prompt for turns and compactions (§5) is not adopted.

## Implementation mapping

- `src/memory.ts`: append-only log, binary summary tree, compression scheduling (§4 of the 2026-10-08 revision: a message's summary starts once fewer than 8 lines before it are unbuilt, a merge once both halves are built, kept in a queue so the tree is never scanned for work), the compactions' own view (§4: the view merged further to 16,000-32,000 bytes, ending at the node and its first unbuilt line), the view (§3.2: the most due pair, measured from its last message, merges in one batch from 128,000 down to 64,000 bytes, and the view is saved to `view.json` rather than refolded at start), zoom/date, and the opt-in text search over original messages (`src/tools.ts` has the tool; not in the recipe, off by default).
- `src/compactor.ts`: contextual compression and size retries, with the 2026-10-08 revision's task (a 512-dash ruler for the size) and its "Too long" retry, verbatim. The compactions' view shows each line under its `id+n|` head, as the task's line ids need, so a reply that copies a head has it removed.
- `src/cache.ts`: Anthropic cache marks: the view in blocks of 4 lines, one mark on the last whole block and one at the request's end, as in recipe §3.3. OpenAI requests get no marks: GPT-5.6 and GPT-6 Luna reject the recipe's `prompt_cache_breakpoint` with a 400 (found by @aaaxn), so they rely on implicit prefix caching. OptChat doesn't set `reasoning.context` either: GPT-5.6 already defaults to the recipe's `"all_turns"`, and OpenAI documents it only for GPT-5.6 and GPT-6.1 Sol.
- `src/memory.ts` and `src/import/job.ts`: text over 29,900 characters that is not tool output is logged as several messages in a row, never cut (§1). The recipe sets no piece size: 29,900 is the 30,000-character tool output cap less room for zoom's `id+0|kind: ` head, so zoom returns a piece whole. A piece ends after a line break when one falls in its second half, and only the last piece holds the input's receipt. Imports plan the same pieces, so each planned entry is one message.
- `src/transcript.ts`: fresh context per parent run, current-run tool loop retained. The previous completed exchange is also retained in full text (left out if over 16,000 bytes by default), an intentional addition to the summary-only recipe for conversational continuity.
- `src/agents.ts`: asynchronous Pi SDK children and automatic completion reports.
- `src/settings.ts`: per-profile settings for the departures from the recipe. Defaults are the recipe's (one subagent level, no memory search), except the previous exchange (on) and the summary size tolerance (640 bytes, against the recipe's strict 512).
- `src/import/`: profile-scoped historical imports retain user messages and final assistant replies, following the lighter history described in recipe section 10. An import hands `Memory` one message at a time, each once the one before it is summarized, so the compactor sees the view a live chat would have shown it. Source adapters, final-reply detection, replay filtering, and ChatGPT branch labels are integration choices. Live-chat tool logging remains unchanged.

Profiles, native Pi UI, conversation import, and local Git checkpoints are integration choices described in the README.
