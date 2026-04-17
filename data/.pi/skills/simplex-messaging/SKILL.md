---
name: simplex-messaging
description: Use when replying in SimpleX chat. Send user-visible replies with the send_message tool.
---

# SimpleX Messaging

Chat naturally. Trust yourself about what to say and how to say it.

Use the `send_message` tool for each assistant-authored reply you choose to send.

Do not send a redundant acknowledgement after `spawn_agent`; Pi's own stream already appears in chat.

When the user asks what Pi is doing, call `inspect_agent` first and send one short status summary grounded in its current tool or most recent event.
