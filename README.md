<p align="center">
  <!--
    Dos variantes a propósito: el logo es trazo blanco sobre transparente, así que
    en el tema CLARO de GitHub quedaría invisible. El oscuro usa el original; el
    claro, la misma marca sobre una tarjeta oscura.
  -->
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo.png">
    <img src="docs/logo-light.png" alt="Albus" width="150">
  </picture>
</p>

<h1 align="center">Albus</h1>

<p align="center">
  <strong>The agent that runs your agents.</strong><br>
  A desktop container where the boring, repetitive parts of your life live as
  agents you can talk to — instead of forty disconnected automations you have to
  remember, maintain, and re-explain.
</p>

---

## Why this exists

Automation today asks you to think like a plumber.

You want your job applications tracked in Notion, your CV tailored per company,
your receipts filed in Drive, your notes turned into a list of things you
actually have to do. So you build a Zap. Then a script. Then a second script
because the first one only worked on Tuesdays. Then a Notion template, a Sheets
formula, a cron job on a Raspberry Pi you forgot the password to.

Six months later you have **forty automations and no system**. Each one knows a
sliver of context. None of them know *you*. And every time you want something
slightly different, you go back to being a plumber — wiring, testing, breaking,
fixing — instead of just saying what you want.

The frustrating part is that the missing piece is not intelligence. Models are
good enough. The missing piece is that **nothing owns the whole picture.**

### The idea

One agent. It knows your rules, holds your connections, and has hands.

```
                     ┌──────────────────────┐
   you talk  ──────▶ │        ALBUS         │
                     │  reads your rules    │
                     │  decides what to do  │
                     └──────────┬───────────┘
                                │  picks a capability
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                 ▼
      ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
      │ job search   │  │  your next   │  │  your next   │
      │    agent     │  │    agent     │  │    agent     │
      └──────┬───────┘  └──────────────┘  └──────────────┘
             │
             ▼  hands it already has
   browser · Notion · Google Drive · Gmail · your files
```

You don't configure it. You **write to it**, in your own words, in a plain
Markdown file:

```markdown
# Job search — my rules

- Nothing with Java, and no night shifts.
- If the salary isn't published, apply anyway.
- Save the CV in this Drive folder: https://drive.google.com/…
- Track applications here: https://www.notion.so/…
- My CV can't have a generic filename — it looks AI-generated.
```

Nobody programmed a `noNightShifts` flag. The agent reads the whole file and it
counts. That is the entire learning mechanism, and it is deliberately boring:
**your agent's memory is a text file you can open, read, correct, and delete.**
A memory only the program understands is a memory you can't audit the day it
does something strange.

---

## What makes it different

### Agents are files, not code

An agent is two files in **your** folder:

```
Documents/albus_agent/agents/
  job-search.agente.json     ← who it is, what it needs, what it may use, what it aims for
  job-search.md              ← your rules, in your words
```

Adding an agent doesn't mean forking this repository. The registry reads the
folder; it doesn't know any agent by name. The one that ships is planted as a
seed on first run and then walks exactly the same path as one you write by
hand — because if it were a special case in the code, *your* path would never
be tested.

### It uses your AI subscription, not ours

Albus drives a local CLI you already pay for (`claude`, `agy`). There is no API
key to provision, no per-token bill from us, and no server that sees your data.
The model runs on your machine, against your files.

### It reads screens instead of guessing selectors

Automating someone else's website with `click('#submit-btn')` is a bet that they
never redesign. We lost that bet twice, and wrote it down.

So capabilities are declared as **goals in plain language** — *"get to the
application form and leave it visible"* — and the model looks at the page and
decides. A goal survives a redesign, a rename, and a change of language. A
selector doesn't.

### The brakes are code, on purpose

Some things must not be a model's opinion:

| Guarantee | How |
|---|---|
| It never submits an application without you | A deterministic classifier gates the submit button. In `review` mode, submit is unreachable. |
| It won't type your data into an arbitrary page | The browser only navigates to hosts with real provenance — the apply link of the job *you* chose. |
| It won't invent facts about you | A field it can't answer from your profile is left empty and reported, never filled with a plausible guess. |
| It can't use a capability you didn't grant | Tools are validated against your agent's manifest before execution, not just hidden from the prompt. |

A brake made of model output isn't a brake. It has to hold precisely *when* the
model is wrong.

### Your data is yours

Everything the app writes lives in `Documents/albus_agent/` — visible, editable,
and backup-able. Uninstalling doesn't delete your rules. Updating doesn't either.
The repository holds code; it never holds your state.

---

## What it does today

**Job search** is the first agent, and it exists because it's the most tedious
loop there is:

- Sweeps LinkedIn and job portals for the roles *your rules* describe
- Scores each opening against your profile and discards what you said to discard
- Builds a CV and cover letter tailored to that company
- Opens the real application form — following the company's own ATS, wherever it
  lives — fills what it can, and **stops before sending**
- Mirrors the result to Notion and your tracker: what actually happened, not
  what was supposed to happen

**Notes → data** turns whatever you captured during the day into something
usable: QR codes, receipts, contacts, open loops, and a graph of how they relate.

**Connections** — Notion, Google (Gmail + Drive), LinkedIn — are set up by
clicking, not by editing a `.env`. The agent navigates the credential screens
itself, because that's just another website to read.

---

## Getting started

**Requirements:** Node 20+, and an AI CLI on your PATH (`claude` or `agy`).

```bash
git clone https://github.com/JDavidcor23/albus_agent.git
cd albus_agent
npm install
npm run dev
```

On first run, Albus creates `Documents/albus_agent/` and plants the job-search
agent there. Open the **agents** tab, hit *edit rules*, and tell it what you
want. Then connect Notion and Google from the same screen.

### What you need to bring

Being straight with you, because "clone and run" is only half true today. The app
boots and the agents tab works, but the job agent needs three things that are
**yours** and that nothing in this repo can invent for you:

**1. Your profile — required.** A JSON with the answers every application form
asks for. There is no screen for it yet: you write the file.

```
Documents/albus_agent/agents/job-search/albus-profile.json
```

It's validated on load, so a missing or malformed key fails loudly with the exact
path instead of guessing. Until it exists, the job agent shows up disabled with
the reason. Copy the shape from
[`resources/albus-profile.fixture.json`](resources/albus-profile.fixture.json) —
that's the fictional profile the browser self-test uses, and it has every key.

**2. Your CV and cover letters, already compiled.** Albus **reads** PDFs; it does
not typeset them. It expects this layout, and the `<slug>` is the company name
normalized (`BC Tecnología` → `bc_tecnologia`):

```
agents/job-search/cv/main_<slug>.pdf
agents/job-search/cover_letters/cover_<slug>*.pdf
```

The LaTeX pipeline that generates them lives in a separate project and is **not
included here**. If you don't have one, drop your own PDFs following that naming
and the agent will attach them — it renames the copy to something a recruiter
should see, and never touches your original.

**3. A Supabase project — only for the notes side.** The *Notes → data* features
(extraction, graph, open loops) read from Supabase and need `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` in `.env`, plus the SQL in
[`supabase/migrations/`](supabase/migrations/) applied by hand. The connection is
created lazily, so **the job agent works without any of this** — you'll just see
an error banner on the notes tabs.

> That service role key is why the capture side is a *separate* web app and not
> part of this one: the key bypasses row-level security completely, and a desktop
> process is the only place it can live without one bad import exposing the whole
> database.

If any of those three is missing, Albus tells you which one and where it goes. It
won't pretend it worked.

---

## Commands

```bash
npm run dev            # app with HMR
npm run typecheck      # THE gate: there is no linter and no test runner
npm run jobs:check     # pure domain + the IPC contract, without Electron or network
npm run ipc:check      # the project's only blind spot: preload keys vs. main's zod schemas
npm run jobs:selftest  # the browser against a synthetic form fixture
npm run ui:selftest    # the agents tab against the real DOM
npm run notion:check   # does the Notion API answer? 401 vs 404. Costs no quota.
npm run nav:inspect -- <url>   # what the agent sees there. Doesn't click, doesn't spend.
```

`npm run typecheck` is the gate for everything. The check scripts are the second
gate, and they are written to run on **any** machine — no personal profile, no
absolute paths, no environment variables to set.

---

## Architecture, briefly

<p align="center">
  <img src="docs/architecture.png" alt="Albus architecture" width="100%">
</p>

```
src/main/core/     pure domain: extraction · jobs · graph · tasks — imports no Electron
src/main/          adapters: agents · browser · connections · jobs · supabase ·
                   notion · drive · gmail · graph · providers · devtools · ipc
src/preload/       contextBridge → window.api
src/renderer/      React. Paints; never reaches into the main process directly
src/shared/        the IPC contract. Imports nothing.
```

The main process owns the domain, the secrets, and the browser. The renderer
paints. Every IPC response is a typed envelope — `{ok:true,data}` or
`{ok:false,error}` — so the UI never receives a raw exception, and the main
process never trusts the UI: payloads are validated with zod on arrival.

Deeper notes live in [`.claude/docs/`](.claude/docs/), including
[`frozen-contracts.md`](.claude/docs/frozen-contracts.md) — the string values
that break things **silently** if renamed, which is the kind of bug that costs
three weeks before anyone notices.

---

## Status

Honest version: the **container** is real and the job-search agent works
end-to-end for most postings. Applications that live behind a third-party ATS
with custom multiple-choice widgets are still where it struggles — that path is
under active work, and the trace it prints tells you exactly where it stopped
instead of claiming success.

Two gaps worth naming, since they're the difference between "runs on my machine"
and "runs on yours": there is **no onboarding screen** for the profile yet (you
write the JSON), and **CV generation isn't part of this repo** (Albus reads
compiled PDFs). Both are listed under [what you need to
bring](#what-you-need-to-bring), and both are the next things to close.

This is a personal project built in the open. If the thesis resonates — one
orchestrator instead of forty scripts — the interesting part isn't the job agent.
It's that the next agent is a file you write, not a pull request you wait for.
