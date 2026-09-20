# Scam checker

[![CI](https://github.com/Sachin-chaurasiya/scam-checker-with-jev/actions/workflows/ci.yml/badge.svg)](https://github.com/Sachin-chaurasiya/scam-checker-with-jev/actions/workflows/ci.yml)

Paste a suspicious text message. Get a straight answer and the reasons behind it.

![A verdict reading "Don't act on this", with what to do and why](screenshots/02-verdict-scam.jpg)

It is for someone worried and not technical. My parents, probably yours too. They get a message saying their account will be blocked today, and there is nobody
to ask at 9pm.

The checking is done by [Jev](https://docs.typesafe.ai), a model that answers typed
questions instead of writing text. One request asks twenty-two short questions about the
message at the same time. Everything after that is ordinary code.

New to Jev? I wrote up [everything I learned about it](JEV-UNDERSTANDING.md) while building
this app: what it is, why it exists, how it works, and where it falls over.

Runs on your own machine. Nothing is stored anywhere. English only, text only, for now.

## Running it

You need Node 24 (the current LTS) and an API key from [TypeSafe](https://console.typesafe.ai/keys).

```bash
pnpm install
cp .env.example .env     # paste your key into .env
pnpm dev                 # http://localhost:3300
```

There is no hosted demo. Every check costs me money, so bring your own key.

It listens on `127.0.0.1` only. It holds your API key and has no rate limiting, so it should
not be reachable from the rest of your network. If you do want that, set `HOST=0.0.0.0`.

There is no build step. Node runs the TypeScript directly.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Serves the page and the `/api/check` endpoint |
| `pnpm test` | Unit tests. No network, no API key needed |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm smoke` | One live call, then the whole pipeline on a sample scam |
| `pnpm eval` | Runs the labelled messages and prints how well it did |
| `pnpm collect` | Add a real message to the labelled set |
| `pnpm fetch-ham` | Download 300 real SMS from a public corpus to test false alarms |

## The five answers

There is no "safe". A checker that says safe and is wrong is worse than no checker.

| Answer | What it means |
|---|---|
| Don't act on this | Enough signs to call it a scam |
| Treat this as suspicious | The message contains text written to fool automatic checkers |
| I can't tell | Genuinely unclear. Go and verify before doing anything |
| Nothing suspicious found | No scam patterns matched. Still not a promise |
| I can't read this one | Not English, so the answer would not be trustworthy |

<table>
<tr>
<td width="50%"><img src="screenshots/01-paste-a-message.jpg" alt="The paste screen"><br><sub>Paste the message</sub></td>
<td width="50%"><img src="screenshots/03-verdict-nothing-found.jpg" alt="A verdict reading nothing suspicious found"><br><sub>A real one-time-code message</sub></td>
</tr>
<tr>
<td><img src="screenshots/04-verdict-cant-tell.jpg" alt="A verdict reading I can't tell"><br><sub>Genuinely unclear</sub></td>
<td><img src="screenshots/05-verdict-suspicious.jpg" alt="A verdict reading treat this as suspicious"><br><sub>A message trying to fool the checker</sub></td>
</tr>
</table>

More in [`screenshots/`](screenshots), including what it does with a message that is not in English.

## How it works

```
paste                                                            answer
  │                                                                 ▲
  ▼                                                                 │
tidy up ──▶ pull out link hosts ──▶ build state ──▶ ONE call ──▶ score it
 (code)          (regex)              (code)      22 questions    (code)
                                                   in parallel
```

Three files carry the product:

- `lib/questions.ts` holds the twenty-two questions. Each one asks a single thing, in plain words.
- `lib/score.ts` holds every weight and cut-off. If a verdict is wrong, the cause is in here.
- `scripts/eval.ts` runs the labelled messages and tells you if you made things worse.

The rest is plumbing: a small HTTP server, one HTML page, and `lib/check.ts` to join them
up. Tests sit next to the code they cover, in `lib/*.test.ts`.

## How good is it, honestly

| Test set | What it is | Result |
|---|---|---|
| `fixtures/messages.jsonl` | 70 messages **I made up** | 0% false alarms, 93% of scams flagged, none called clear |
| `fixtures/public-ham.jsonl` | 300 **real** SMS. Not in the repo, run `pnpm fetch-ham` first | 0 flagged as scams, 31 landed in "I can't tell" |
| `fixtures/injection.jsonl` | 10 messages that try to talk the checker down | 10 out of 10 caught |

Read that first row carefully. The scam messages are invented, so the 93% tells you the
harness works. It does not tell you the checker works.

The real SMS are genuine, but they are old British personal texts. No UPI, no KYC, no OTP
formats, and no modern scams at all.

They earned their place once. They caught the checker flagging "send me your id and
password" between two friends, which is how the personal-conversation question ended up in
the catalogue.

They are also real people's private messages, so this repo holds the script that fetches
them rather than a copy. The sample is picked by hashing, so everyone gets the same 300 and
the numbers stay comparable.

**What is missing is real scam messages.** No public dataset has current Indian scam SMS.
That half has to come off real phones.

```bash
pnpm collect      # paste, blank line, s/l/a, optional sender
pnpm eval
```

Collect the boring genuine ones too, not just the scams. Bank debits, OTPs, delivery
updates, offers. Those are what cause false alarms, and one false alarm is enough to make
someone stop trusting it.

## Changing it

Run `pnpm eval` before and after every change. It fails the run if false alarms go
above 5% or if fewer than 85% of scams get flagged.

When a verdict is wrong, look at the question before you touch a weight. Twice now the
fix was wording, not arithmetic:

- `asks_to_keep_secret` fired on "do not share this code with anyone", which is a bank
  warning that protects you. The question had to say so.
- A scam that said "call our officer on 8XXXX" slipped through because no question asked
  about phone numbers at all.

## Cost

Around $0.0001 per check, measured at 2,245 input tokens. Input tokens are charged and
output tokens are free, so a full run of all 70 messages costs well under a cent.

## Before you trust it

This is a side project, not a security product. It can be wrong in both directions. It
gives a second opinion, nothing more.

If money or an account is involved, stop and call the company on a number you already
have. Never a number from the message. And nobody legitimate will ever ask you for an
OTP, a PIN or a password.

## Credits and licence

`pnpm fetch-ham` samples the SMS Spam Collection by Tiago A. Almeida, José María Gómez
Hidalgo and Akebo Yamakami, published through the UCI Machine Learning Repository.

MIT. See [LICENSE](LICENSE).
