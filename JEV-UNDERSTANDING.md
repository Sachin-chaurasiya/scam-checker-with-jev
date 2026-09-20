# Understanding Jev

A guide to TypeSafe's Jev model, in four parts: **what** it is, **why** it exists, **how** it
works, and how to **engineer** with it.

Most of it comes from [docs.typesafe.ai](https://docs.typesafe.ai); the comparison with other
models is sourced separately at the end. Where TypeSafe makes a performance claim that nobody
independent has checked, it is marked **[their claim]**. The examples come from the scam
checker in this repo, so they are real code and real numbers.

---

# 1. What

Jev is a model that makes decisions instead of writing text.

You send two things:

- **state**: the thing you want looked at
- **questions**: what you want decided, each with a type you choose

You get back a typed answer for each question, with a probability attached to it.

```
  ┌─────────────┐        ┌───────────────┐        ┌──────────────────┐
  │    state    │        │   questions   │        │     answers      │
  │             │───────▶│               │───────▶│                  │
  │ "your KYC   │        │ asks for OTP? │        │ 0.98             │
  │  is pending │        │ which scam?   │        │ "bank_fake" 0.87 │
  │  ..."       │        │ how bad?      │        │ 2.4 of 3         │
  └─────────────┘        └───────────────┘        └──────────────────┘
      what you            what you want            what your code
      want judged            decided                 branches on
```

## The three question types

There are only three. That is the whole vocabulary.

| Type | You ask | You get back |
|---|---|---|
| **Noul** | Is this true? | One number, 0 to 1. The chance the answer is yes. |
| **Choice** | Which one of these? | The winner, a probability for every option, and a confidence. |
| **Score** | Where on this scale? | A position that can land between two of your levels, plus probabilities and confidence. |

You define the possible answers. The model cannot return anything outside them.

## The shape of one call

```
REQUEST                                  RESPONSE
{                                        {
  "state":  <string | object | array>      "model": "jev-1.13.0",
  "model":  "jev-latest",                  "answers": {
  "questions": {                             "is_urgent": {
     "is_urgent": {                             "type": "noul",
        "type": "noul",                         "noul": 0.92
        "instructions": "Is this urgent?"    }
     }                                      },
  }                                        "usage": {
}                                            "input_tokens": 312,
                                             "output_tokens": 48
                                           }
                                         }

  • you name each question, the answer comes back under the same name
  • the name is never shown to the model, so put the full question in `instructions`
  • you pay for input tokens only
```

One endpoint: `POST https://api.typesafe.ai/v1/systemone`.

The name comes from Kahneman. System 1 thinking is fast and instinctive, System 2 is slow and
careful. Jev is deliberately only the fast half.

## What it will not do

It does not chat, write code, or explain itself. It cannot count, do arithmetic, or compare
dates. It reads text only, so no images, audio or video. Keep all of that in your own code.

---

# 2. Why

## It is not about parsing JSON

If you last looked at this a while ago, the pitch used to be "stop parsing JSON out of an LLM".
That argument is dead. OpenAI, Anthropic and Google all support structured outputs now.
They enforce your schema with constrained decoding, which means the model can only pick
tokens that keep the output valid. An invalid enum value or a missing key cannot come out.
Reported failure rates are below 0.1%.

So a modern LLM gives you valid JSON too. The real difference is in **how the answer is
produced** and **what comes with it**.

```
  AN LLM WITH STRUCTURED OUTPUTS

  ┌────────┐   ┌──────────────┐   ┌───────────────────────────────────┐
  │ state  │──▶│ prompt +     │──▶│  constrained decoding             │
  │        │   │ JSON schema  │   │                                   │
  └────────┘   └──────────────┘   │  field1 ──▶ field2 ──▶ field3     │
                                  │      each one is written after,   │
                                  │      and conditioned on, the last │
                                  └─────────────────┬─────────────────┘
                                                    ▼
                                    valid JSON. One value per field.
                                    A "confidence" field, if you asked
                                    for one, is just more generated text.


  JEV

  ┌────────┐   ┌──────────────┐   ┌───────────────────────────────────┐
  │ state  │──▶│ N typed      │──▶│   q1    q2    q3    ...           │
  │        │   │ questions    │   │   │     │     │    all at once,   │
  └────────┘   └──────────────┘   │   ▼     ▼     ▼    none can see   │
                                  │                    another        │
                                  └─────────────────┬─────────────────┘
                                                    ▼
                                    a probability across every option
                                    you defined, for every question
```

## What actually differs

| | LLM with structured outputs | Jev |
|---|---|---|
| Valid JSON, matching your schema | Guaranteed | Guaranteed |
| What you get per field | One value | A probability for every option |
| Confidence | Only if you ask for a field, and it is generated text, not a measured probability | Calibrated, derived from the distribution |
| Can one field sway another? | Yes. They are written in sequence, so later fields are conditioned on earlier ones | No. Each question is answered on its own |
| Cost of one more question | More output tokens, more time | Almost no extra time |
| Output tokens | Charged, usually the expensive side | Free |
| Speed | **[their claim]** 40–200× slower than Jev on comparable work | ~1.2s for 22 questions, measured here |

Both guarantee the *shape*. Neither guarantees the *answer is right*.

## So what is Jev actually for

Mostly the probabilities. An LLM hands you a decision. Jev hands you a decision and a number
saying how sure it is, on a scale trained to mean something, which your code can threshold on.
Ask an LLM for a confidence field and you get a plausible-looking number produced the same way
as the rest of its text.

Then there is isolation. In one structured-output call the model writes your fields in order,
so field 12 is written knowing fields 1 to 11. Jev answers every question against the state on
its own. In this app that means I can add a question without re-testing the other twenty-one.

Last, volume. Free output tokens and a single parallel pass make it cheap enough to ask
twenty-two questions of every message instead of rationing them.

## When the LLM is still the right call

Use an LLM when you need the *text*: a reply, a summary, code, an explanation of the reasoning.
Use one when the schema has free-text fields that must be written, not chosen. Use one for a
one-off where 1.2 seconds against 4 seconds does not matter and you would rather not add
another vendor. Jev earns its place when the same narrow judgement is made thousands of times
and you need to know how sure it is.

## Why the probabilities mean something

Most models are trained to sound right. Jev is trained to be calibrated.

```
                        RLHF ──▶ chat models
                     (say what people prefer, which also
                      rewards confident nonsense)

  pretrained model ──▶ RLVR ──▶ reasoning models
                     (train against checkable answers:
                      slower, more expensive)

                        RLCD ──▶ Jev
                     (train the probabilities against
                      what actually happened)
```

RLCD is TypeSafe's method: reinforcement learning for calibrated decisions. What "calibrated"
means in practice:

```
  predicted │                              ●     perfect calibration
    chance  │                       ●            puts every dot on the line
     1.0    │                ●
            │          ●
     0.5    │     ●
            │
     0.0    └─────────────────────────────────
            0.0          0.5             1.0
                    what actually happened

  Of everything it scored 0.8, about 80% should turn out true.
```

This holds across **groups** of answers. It promises nothing about any single one.

---

# 3. How

## Every question is answered at the same time

The state is read once. Each question is answered against it independently and in parallel.

```
                       one state, read once
                      ┌──────────────────────┐
                      │   the text message   │
                      └───────────┬──────────┘
                                  │
     ┌──────────┬──────────┬──────┴─────┬───────────┬──────────┐
     ▼          ▼          ▼            ▼           ▼          ▼
  asks for   creates   claims to be  link looks   how much   which
   an OTP?   urgency?    a bank?       wrong?     harm?      scam?
   (noul)     (noul)     (noul)        (noul)     (score)   (choice)
     │          │          │            │           │          │
     └──────────┴──────────┴──────┬─────┴───────────┴──────────┘
                                  ▼
                       all answers, one round trip
```

Three consequences:

1. More questions barely cost more time. Twenty is as quick as one.
2. No question can affect another. Answers cannot leak sideways.
3. So ask everything up front, even for branches you might not take.

## Reading a Score answer

```
  "How much damage if the reader does what it asks?"
  levels = ["None", "Wasted time", "Money or data lost", "Life savings"]
                     ↑ the order of your array is the numbering

    0  None                ██                        p = 0.03
    1  Wasted time         ████                      p = 0.07
    2  Money or data lost  ████████████              p = 0.30
    3  Life savings        ████████████████████████  p = 0.60

    score      = 0(0.03) + 1(0.07) + 2(0.30) + 3(0.60) = 2.47
    confidence = 0.81      ← how peaked those bars are
```

Between 2 and 10 levels. The score is a **position on your scale**, not a measurement. Do not
read 2.47 as a real-world quantity.

## Reading confidence

Choice and Score answers carry a `confidence`. Noul does not, because the number already
carries it. A value of 0.5 means the model genuinely cannot decide.

Confidence is worked out from the spread of probabilities. Spread out means unsure. Peaked
means sure.

```
  confidence  0.0 ─────────── 0.5 ─────────── 0.8 ─────────── 1.0
               │   LOW          │   MEDIUM      │   HIGH
               │                │               │
               ▼                ▼               ▼
        do not act        act, but check   act automatically
        ask a human       with the person

  Choose the cut-off per action, not per system.
  Showing a screen?  0.5 is fine.
  Moving money?      demand 0.9.
```

## What to put in the state

A plain string works. An object is better, because naming the parts gives the model
something to point at. You can then reference a field inside a question, in backticks:

```
  state:    { "message": "...", "sender": "VM-SBIBNK" }
  question: "Does the organisation named in `message` conflict with `sender`?"
```

Filter before you send. Content unrelated to the question measurably lowers accuracy.

---

# 4. Engineering

## Keep your code in charge

The model judges at one point. Everything else stays in code you can read and test.

```
  ┌──────────────────────── your app ────────────────────────┐
  │                                                          │
  │  validate ──▶ fetch and filter ──▶ build the state       │
  │   (code)          (code)              (code)             │
  │                                          │               │
  │                                          ▼               │
  │                                  ┌───────────────┐       │
  │                                  │  one call     │──────────▶ Jev
  │                                  │  N questions  │◀────────── answers
  │                                  └───────┬───────┘       │
  │                                          │               │
  │  thresholds ──▶ weights ──▶ branch ──▶ do the thing      │
  │    (code)        (code)     (code)       (code)          │
  └──────────────────────────────────────────────────────────┘
```

This is the opposite of an agent loop, where the model picks the next step.

## Break big judgements into small ones

```
  ONE BIG QUESTION                  MANY SMALL ONES
  ┌────────────────────┐            ┌──────────────────────────┐
  │ "Is this a scam?"  │            │ q1  asks for an OTP?     │─┐
  │        ↓           │            │ q2  unexpected prize?    │─┤
  │       0.61         │            │ q3  sender mismatch?     │─┤
  └────────────────────┘            └──────────────────────────┘ │
   What moved it? Unknown.            three numbers you can read │
   Nothing to tune. Nothing              and argue with          │
   to explain to anyone.                                         ▼
                                    code:  0.45*q1 + 0.30*q2 + 0.25*q3

  When priorities change you edit a number, not a prompt.
```

A good question is one a knowledgeable person could answer in a second. If it needs several
steps of reasoning, split it.

## Let uncertainty pick the code path

```
                       ┌── low confidence ──▶ a human looks at it
  answer + confidence ─┼── medium ──────────▶ act, but confirm first
                       └── high ────────────▶ act
```

The answer tells you **what**. The confidence tells you **whether to act**.

## Numbers to plan around (jev-1.13)

| | |
|---|---|
| Price | $0.042 per million input tokens. Output free. |
| Context | 64k per request. 32k for the state plus your longest question. |
| Rate limits | 250,000 tokens a second, 1,200 requests a minute. |
| Input | Text only: string, JSON object, or array of text. |
| Errors | 401 bad key, 422 bad request, 429 slow down, 529 overloaded |

`jev-latest` moves when a new version ships, and your answers move with it. If you have tuned
any thresholds, pin the exact version. This repo pins `jev-1.13.0`.

You cannot fine-tune it. Everyone gets the same weights. You shape it through the state, the
wording of your questions, and how you combine the answers.

## Where it is rough, and what to do

| Problem | What to do instead |
|---|---|
| **It reads you literally.** It answers the words, not the intent. | State the exact condition. Put the edge cases in `criteria`. |
| **It cannot count.** | Count in code, or ask one Noul per item and add them up. |
| **Numbers and codes confuse it.** Colour names beat hex values. | Convert to words or buckets in code first. |
| **Score levels are not precise numbers.** | Threshold on them. Never read an exact value between two levels. |
| **Dates are just text to it.** | Extract the parts as Choices, do the date maths in code. |
| **Indirection costs accuracy.** Double negatives, a property of a property. | Write plainly. Name the exact field. |
| **A big, noisy state hurts.** | Filter first. A Noul makes a decent relevance filter. |
| **It does not treat input as hostile.** Text can argue for its own innocence. | Be explicit in the criteria. Test the nasty cases. |
| **Questions are not consistent with each other.** `P(x)` and `1 − P(not x)` need not agree. | Never carry a threshold from a Noul to a Choice. |
| **It does not generate text.** | Use an LLM, or find candidates with a regex and let Jev pick. |

Three of these cost me real time while building this app:

- A question asked whether a message "tells the reader to keep it private". A genuine bank
  SMS saying *"do not share this code with anyone"* scored **0.92**. Literally true, and my
  question was the thing that was wrong. The criteria now say a security warning is a no.
- A fake disconnection notice slipped through. Its only tell was "call our officer on
  8XXXXXXX07", and no question asked about phone numbers. A missing question is a signal you
  will never get.
- Real messages flagged *"Send me your id and password"* between two friends. Scam-shaped
  words are ordinary between people who know each other, so a personal-conversation question
  now dampens the score.

The lesson in all three: when an answer is wrong, look at the question before you touch a
weight.

## When to use something else

```
  need written text, code, or an explanation      ──▶ an LLM
  need planning, several steps, tools             ──▶ an agent or reasoning model
  need exact maths, dates, counts                 ──▶ ordinary code
  need a fast judgement over a known answer set   ──▶ Jev
```

---

# Getting started

```bash
curl -X POST https://api.typesafe.ai/v1/systemone \
  -H "Authorization: Bearer $TYPESAFE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "state": "Your KYC is pending. Your account will be blocked today.",
    "model": "jev-latest",
    "questions": {
      "is_urgent": { "type": "noul", "instructions": "Does this message create urgency?" }
    }
  }'
```

In TypeScript, which is what this repo uses:

```ts
import { TypeSafeClient, choice, noul } from "@typesafe-ai/sdk";

const client = new TypeSafeClient({ defaultModel: "jev-1.13.0" });

const { answers } = await client.systemOne({
  state: { message, sender },
  questions: {
    is_urgent: noul("Does `message` create urgency?"),
    playbook: choice("Which kind of scam is this?", {
      bank_impersonation: "Pretends to be a bank",
      delivery_fee: "Claims a parcel needs a fee",
      looks_legitimate: "Nothing suspicious",
    }),
  },
});

answers.is_urgent.noul;           // 0.98
answers.playbook.choice;          // "bank_impersonation"
answers.playbook.confidence;      // 0.87
```

The types carry through. `answers.playbook.choice` is narrowed to the three names you wrote,
with no casting.

To see it working end to end, read [`lib/questions.ts`](lib/questions.ts) for the questions,
[`lib/score.ts`](lib/score.ts) for the thresholds, and [`lib/check.ts`](lib/check.ts) for the
call.

# Sources

- [Quickstart](https://docs.typesafe.ai/introduction/quickstart)
- [Primitives](https://docs.typesafe.ai/primitives)
- [Confidence](https://docs.typesafe.ai/confidence)
- [API reference](https://docs.typesafe.ai/api)
- [Models and pricing](https://docs.typesafe.ai/models)
- [AI primer](https://docs.typesafe.ai/introduction/machine-learning-primer), on how RLCD differs from RLHF
- [Where jev-1.13 is jagged](https://docs.typesafe.ai/model-jaggedness/jev-1.13), TypeSafe's own list of what it gets wrong
- [Full documentation index](https://docs.typesafe.ai/llms.txt)

On structured outputs, for the comparison in part 2:

- [OpenAI: structured outputs](https://platform.openai.com/docs/guides/structured-outputs), the schema guarantee and how strict mode works
- [Anthropic: tool use](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview), where Claude puts structured data
- [Gemini: structured output](https://ai.google.dev/gemini-api/docs/structured-output), the `responseSchema` approach
