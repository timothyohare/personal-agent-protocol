# Spec section 7 (Conversations): build notes

*Condensed from the Poppy draft 0.1 spec (https://personalagentprotocol.org/docs/spec, section 7), fetched 12 October 2026, for Tasks 15–19. This is a paraphrase, not the spec text. Check the spec itself when in doubt.*

## Requests (7.2)

| Request | Result |
|---|---|
| `POST {endpoint}` `{"message": {...}}` (optionally `parent_conversation_id`) | 201 `{conversation_id, status, responder}` |
| `POST {endpoint}/{id}/messages` `{"message": {...}}` | 202 `{conversation_id, status, responder}` |
| `GET {endpoint}/{id}/events?cursor=&wait=` | 200 `{conversation_id, events, cursor, has_more, status, responder}` |
| `POST {endpoint}/{id}/handoff` `{}` | 202 `{status, responder}` |
| `POST {endpoint}/{id}/close` `{}` | 200 `{status, responder}` |

- Every request carries a DPoP Session Token. The conversation belongs to the `client_id` and User ID that started it, or to the account once it has used one.
- IDs are 1–256 characters of `[A-Za-z0-9_-]`, with a prefix (`cnv_`, `msg_`, `evt_`). The Company picks conversation and event IDs. The agent picks message IDs, which are unique per User.
- Both POSTs accept `?wait=N[&cursor=]`. The body is then a read from that cursor, but the status stays 201 or 202.

## Messages (7.3, 7.4)

- `id` and `sender` (`agent` or `human`) are required, plus at least one of `text`, `data` (an object) or `context` (`locale`, `time_zone`, `user_available`, among others; a partial update; sent by the agent only).
- Retries: the same `id` with the same content returns the original response and adds nothing. A retried first message returns the existing conversation. The same `id` with different content is 409 `message_id_conflict`.
- Company messages carry `id`, `sender`, `text` and `data`. In events, each message also has `role` (`user` or `company`).

## Events (7.5–7.7)

- Every event has `id`, `type` and `created_at` (RFC 3339). The types:
  - `message` (with `message`)
  - `state` (`status`, `responder`)
  - `authorization` (`error`, `scope`)
  - `user_requested` (`reason`)
  - `direct_opened` / `direct_closed` (`conversation_id`)
- No cursor means read from the start. Cursors are opaque. A `wait` timeout returns empty `events`. If `has_more` is true, read again. 410 `cursor_expired` means read from the start again. 400 `invalid_cursor` covers an unknown cursor or one from another conversation.
- SSE (`Accept: text/event-stream`): the SSE `id` is the event id, and `data` is the event JSON. Resume with `Last-Event-ID`. `text-delta` (`message_id`, `text`, no SSE `id`) is display-only.
- `status` is `working`, `idle`, `queued` or `closed`. `responder` is `agent` or `human`. Each change emits a `state` event.

## Handoff, direct conversations, sign-in, close (7.9–7.12)

- **Handoff:** `queued` until a person joins (then `responder: human`). If nobody is available, back to `idle` with an explanatory message. Close cancels a pending handoff.
- **Direct conversations:** the parent must be open, have the same owner and not itself be direct. There's one open direct conversation per parent. The parent gets `direct_opened` and `direct_closed`. While a direct conversation is open, the parent's messages and handoff return 409 `direct_conversation_open` with `conversation_id`. Closing the parent closes the direct one.
- **Sign-in:** the Company emits `authorization` (`sign_in_required` or `insufficient_scope`, plus `scope`) and should also send a message. The agent continues the same conversation with its new token. Once the account has been used, a token for the same User that isn't signed in to it gets `sign_in_required`.
- **Close:** emits `state: closed`. Events stay readable, and new messages get 409 `conversation_closed`.

## Errors (7.13)

| Error | Status |
|---|---|
| `conversation_not_found` (every ownership failure looks the same) | 404 |
| `conversation_closed`, `direct_conversation_open`, `message_id_conflict` | 409 |
| `invalid_cursor` | 400 |
| `cursor_expired` | 410 |
