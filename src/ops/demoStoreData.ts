/**
 * Content for the store built by `buildDemoStore`. Every studio, person,
 * client, project, price and date below is INVENTED. Nothing here is drawn
 * from anyone's real notes, and nothing here should ever be replaced with
 * real notes: this file ships inside the published package, so whatever is
 * written here is handed to every person who installs it.
 *
 * The subject is a small design studio (Pinemoor Studio) and its client work.
 * The point is to show the KINDS of memory worth keeping: decisions with the
 * reasoning attached, gotchas that cost someone a day, conventions the team
 * agreed, and the reasons a path was NOT taken. The chronology is invented but
 * internally consistent: entries reference earlier entries, several reverse an
 * earlier decision, and a few gotchas land after the decision they undermine.
 *
 * Timestamps are baked literals so two builds are byte-identical. Entries are
 * pre-sorted ascending inside each topic, every timestamp is globally unique,
 * and `supersedesIndex` always points at a lower index in the same topic.
 *
 * If you edit summaries here, re-run the banned-language sweep in
 * test/demo-store.test.ts: no em-dashes, and none of the meta words that would
 * give away that a person did not write this.
 */

export interface DemoEntryData {
  type: "decision" | "pattern" | "gotcha" | "convention" | "supersede";
  project: string;
  agent: string;
  summary: string;
  /** Baked event time (ISO); entries are pre-sorted ascending per topic. */
  ts: string;
  /** Index (within this topic's entries) of the entry this one supersedes. */
  supersedesIndex?: number;
}

export interface DemoTopicData {
  id: string;
  title: string;
  /** Curated note body (before the `## Owner notes` stub). */
  body: string;
  entries: DemoEntryData[];
}

export const DEMO_TOPICS: DemoTopicData[] = [
  {
    "id": "studio-pricing-model",
    "title": "How we price: fixed fee phases, and the one place hourly survives",
    "body": "Pinemoor prices client work as a fixed fee per phase. Hourly is gone from everything except one narrow case, and the reason it is gone is written down here so nobody rediscovers it the expensive way.\n\n## The shape\nThree phases on most identity work: discovery, direction, production. Each phase has its own fee, its own counted deliverables, and its own approval. A phase that has not been approved does not start the next one.\n\n## Numbers we hold to\n- 40 percent deposit before discovery begins. No deposit, no calendar slot.\n- Two revision rounds inside every phase fee. Round three is a change order at a stated price.\n- The fee is one number. Never a rate times an estimate. The client is buying an outcome, not our afternoons.\n- Deliverables are counted in the proposal. The word phase protects nobody on its own.\n\n## Where hourly survives\nOngoing production work with no defined end: artwork rolls, retouching, small updates for a client we already know. That work has no shape to price and pretending otherwise produced worse quotes than simply billing the time.\n\n## What it cost to learn\nHourly punished speed. The better and faster we got, the less we earned for the same result. The job that made it obvious is in the log below.",
    "entries": [
      {
        "type": "decision",
        "project": "studio",
        "agent": "team",
        "summary": "Pricing is hourly at one flat studio rate for everybody, tracked in the timesheet and billed monthly. Chosen because it is easy to explain, easy to defend when a client asks what they are paying for, and because it means we never lose money on a job that runs long.",
        "ts": "2026-05-05T09:12:44.041Z"
      },
      {
        "type": "gotcha",
        "project": "studio",
        "agent": "team",
        "summary": "Hourly punishes us for being good. The identity we finished in three days billed less than half of the one that took three weeks, and the three day one was the better piece of work. The client who got the fast job also got the bargain, which is backwards.",
        "ts": "2026-05-14T16:38:02.042Z"
      },
      {
        "type": "supersede",
        "project": "studio",
        "agent": "team",
        "summary": "Moving to a fixed fee per phase: discovery, direction, production, each with its own number and its own approval. 40 percent deposit before discovery starts. We keep the timesheet, but only to check our own estimates afterwards, never to build an invoice from.",
        "ts": "2026-05-26T10:04:51.043Z",
        "supersedesIndex": 0
      },
      {
        "type": "convention",
        "project": "studio",
        "agent": "team",
        "summary": "Every fee states how many revision rounds it includes. Two. Round three onward is priced per round and named in the proposal, so asking for it is a decision the client makes with a number in front of them, not a favour they ask for and we resent.",
        "ts": "2026-06-03T11:47:19.044Z"
      },
      {
        "type": "gotcha",
        "project": "ridgehaul",
        "agent": "team",
        "summary": "The first fixed fee job bled anyway, because we wrote the word phase without saying what was inside it. Fixed fee only protects you if the deliverables are counted in the document. Detail is in ridgehaul-rebrand-scope.",
        "ts": "2026-06-30T17:22:36.045Z"
      },
      {
        "type": "decision",
        "project": "studio",
        "agent": "accounts",
        "summary": "Hourly stays for one case only: ongoing production with no defined end, like artwork rolls and small updates for clients we already know. Anything with a shape gets a fixed fee. Anything shapeless gets billed by time at a rate we revisit every January.",
        "ts": "2026-07-14T09:58:07.046Z"
      }
    ]
  },
  {
    "id": "studio-proposal-shape",
    "title": "What goes in a proposal, and the two sections that do the work",
    "body": "A proposal is two pages. If it needs more than two pages we have not understood the job yet.\n\n## The four sections\n1. What we understood. The brief in our words, so a misunderstanding surfaces before the money does.\n2. What we will do. Counted deliverables, per phase, with dates.\n3. What we need from you. Dated, and with the consequence stated: a date they miss moves the timeline by the same number of days.\n4. What it costs. One number per phase, plus the deposit and the terms.\n\n## The two that actually earn their place\nAssumptions and exclusions. Every painful conversation we have had started with something nobody wrote down: who is paying for photography, whether print buying is ours, whether the old files exist. If it is not listed as included, list it as excluded.\n\n## Two options, never three\nThe scoped version and a smaller one that still solves the problem. Three options makes the client a project manager and they start mixing rows. Two options makes them choose a size.\n\n## Housekeeping\nProposals expire after 21 days. Prices move, calendars fill, and an open quote from four months ago is a liability we do not need to honour.",
    "entries": [
      {
        "type": "decision",
        "project": "studio",
        "agent": "team",
        "summary": "Proposals are capped at two pages: what we understood, what we will do, what we need from you, what it costs. The long ones were not winning more work, they were just taking a day to write and getting skimmed to the last page anyway.",
        "ts": "2026-05-06T14:21:09.517Z"
      },
      {
        "type": "pattern",
        "project": "studio",
        "agent": "team",
        "summary": "Two options, not three. A scoped version and a smaller version that still solves the problem, each with a name rather than a letter. Three options turns the client into a project manager who mixes rows from different columns and expects the lowest price.",
        "ts": "2026-05-19T08:47:33.518Z"
      },
      {
        "type": "convention",
        "project": "studio",
        "agent": "team",
        "summary": "Every proposal carries a dated what we need from you list, with the consequence written next to it: a date they miss moves the delivery date by the same number of days. Saying it once at the start is worth more than saying it three times when it happens.",
        "ts": "2026-06-04T15:12:58.519Z"
      },
      {
        "type": "gotcha",
        "project": "bramblewell",
        "agent": "team",
        "summary": "Sent a proposal with the assumptions section deleted to save space. The client assumed photography was included and had already told their buyer so. We ate a half day shoot to keep the relationship. The assumptions section is not the padding, it is the point.",
        "ts": "2026-06-17T10:33:41.520Z"
      },
      {
        "type": "decision",
        "project": "studio",
        "agent": "accounts",
        "summary": "Proposals now expire 21 days after they are sent, stated on the cost page. Two quotes from the spring came back months later expecting the old number and the old calendar slot, and both times saying no felt like we were the ones being difficult.",
        "ts": "2026-07-07T13:05:16.521Z"
      }
    ]
  },
  {
    "id": "studio-invoicing-terms",
    "title": "Deposits, payment terms, and the chase ladder",
    "body": "Getting paid is a design problem. It has a process and the process is here.\n\n## Terms\n- 40 percent deposit before work starts, invoiced with the signed proposal.\n- Balance on approval of the final phase, net 15.\n- Work stops at 30 days past due. Written into the proposal at the start so it is a rule, not a threat.\n\n## Timing\nInvoice the same day a phase is approved. Not on the first of the month, not when we get round to it. Every day between the approval and the invoice is a day added to the front of their payment run, and a week of drift here is a week of drift everywhere.\n\n## Purchase orders\nLarger clients cannot pay an invoice that has no purchase order number on it. It does not bounce, it just silently never enters the queue. Ask for the number at kickoff and put it on every invoice.\n\n## The chase ladder\n1. Day 3 after due: a short reminder by email, no apology in it.\n2. Day 10: a phone call to a person, not the shared accounts address.\n3. Day 30: work stops, in writing, referring to the clause they already agreed to.\n\nNobody enjoys step three, but the two clients who reached it both paid within a week, and both are still clients.",
    "entries": [
      {
        "type": "decision",
        "project": "studio",
        "agent": "accounts",
        "summary": "Standard terms are net 30 from the invoice date, no deposit, because asking for money up front felt like we were saying we did not trust them.",
        "ts": "2026-05-07T11:02:27.883Z"
      },
      {
        "type": "gotcha",
        "project": "ridgehaul",
        "agent": "accounts",
        "summary": "Net 30 is not net 30 at a client with a monthly payment run. Our invoice missed the cutoff by two days and sat until the following month, so net 30 was net 55 in practice. Nobody did anything wrong. The terms were just written for a company that does not exist.",
        "ts": "2026-05-28T09:41:12.884Z"
      },
      {
        "type": "supersede",
        "project": "studio",
        "agent": "accounts",
        "summary": "New terms: 40 percent deposit before work starts, balance net 15 on phase approval, work stops at 30 days past due. All three go in the proposal so they are agreed before there is any tension about money. The deposit has not cost us a single job so far.",
        "ts": "2026-06-09T16:19:44.885Z",
        "supersedesIndex": 0
      },
      {
        "type": "convention",
        "project": "studio",
        "agent": "accounts",
        "summary": "Invoice the same day a phase is approved. Never at month end. Batching invoices to the last Friday felt tidy and quietly pushed every payment three weeks later than it needed to be.",
        "ts": "2026-06-11T08:58:03.886Z"
      },
      {
        "type": "pattern",
        "project": "studio",
        "agent": "accounts",
        "summary": "The chase ladder, so nobody has to invent tone under pressure: day 3 a short reminder with no apology in it, day 10 a phone call to a named person rather than the shared accounts address, day 30 work stops in writing against the clause they already agreed to.",
        "ts": "2026-06-25T14:37:55.887Z"
      },
      {
        "type": "gotcha",
        "project": "fernpost",
        "agent": "accounts",
        "summary": "An invoice with no purchase order number on it does not bounce, it just never enters the payment queue and nobody tells you. Six weeks of silence, then a one line answer when we finally called. Ask for the purchase order at kickoff, not when you are invoicing.",
        "ts": "2026-07-16T10:26:31.888Z"
      }
    ]
  },
  {
    "id": "scope-change-orders",
    "title": "Change orders: how a quick favour becomes three weeks",
    "body": "Scope does not creep. It gets carried in one small piece at a time by people being helpful.\n\n## The rule\nAnything past the two included revision rounds is a change order: one paragraph, one number, one date, sent by email. No verbal change orders, even for clients we like, especially for clients we like.\n\n## Free work still gets logged\nWe still do small things for free. The mistake was not doing them, it was not writing them down. At the end of a job we could not show the client anything we had absorbed, so the value of it was invisible and the goodwill bought nothing. Now every absorbed change is logged with a value and a zero next to it, and the list goes in the wrap up.\n\n## Approvals reopen\nA change that touches an already approved phase reopens that phase. This sounds bureaucratic and it is, but the alternative is a client who signed off on a direction in May receiving something different in July and being right to be annoyed.\n\n## The tell\nIf someone in the studio says just while we are in there, that is a change order. It has never once been ten minutes.",
    "entries": [
      {
        "type": "pattern",
        "project": "studio",
        "agent": "production",
        "summary": "Every request that arrives outside a review round gets written in the same place, whether we charge for it or not. One line, the date, who asked, and what it would cost. Half the value is just that the list exists and can be looked at.",
        "ts": "2026-05-20T15:44:08.209Z"
      },
      {
        "type": "decision",
        "project": "studio",
        "agent": "team",
        "summary": "Anything past revision round two is a change order with a price and a date attached before it starts. Not negotiable per client, because the moment it is negotiable per client it becomes a test of who is best at asking.",
        "ts": "2026-06-02T09:23:50.210Z"
      },
      {
        "type": "gotcha",
        "project": "slatefield",
        "agent": "production",
        "summary": "The free favours were never the problem. The problem was that we did not log them, so at the wrap up we had absorbed maybe four days of work and had nothing to point at. The client genuinely did not know, and reasonably assumed it had all been in the fee.",
        "ts": "2026-06-16T17:11:26.211Z"
      },
      {
        "type": "convention",
        "project": "studio",
        "agent": "team",
        "summary": "A change order is one paragraph, one number, one date, by email. Long ones read as defensive and invite negotiation on the wording rather than the work. Short ones get approved in a reply that is usually the single word yes.",
        "ts": "2026-06-24T12:39:04.212Z"
      },
      {
        "type": "decision",
        "project": "studio",
        "agent": "team",
        "summary": "A change order touching an already approved phase reopens that phase for approval. Feels heavy, but the alternative is delivering something in July that quietly stopped matching what they signed off in May, and having no record of when it moved.",
        "ts": "2026-07-09T08:52:47.213Z"
      }
    ]
  },
  {
    "id": "studio-tooling-stack",
    "title": "Tools we run on, and the ones we turned off",
    "body": "Small studio, so every tool is a subscription somebody has to justify.\n\n## What we run\n- One file host, one folder tree, one naming convention. Everything anywhere else is a copy and is treated as untrusted.\n- Design tool with shared libraries, one library per client.\n- A shared board for jobs in flight, with a blocker line per job.\n- Bookkeeping and invoicing in one place that the accountant can read without us.\n\n## What we turned off\nThe all in one studio platform. We trialled it for two weeks and it wanted to own time tracking, invoicing, files, briefs and chat, and did all five at about 60 percent of what the single purpose tools do. Switching cost would have been a fortnight and the exit cost would have been our whole history. The pitch is real, the maths is not, and it will come round again in a year sounding new.\n\nAlso off: the stock photography subscription. We used it four times in a year and paid for it twelve.\n\n## The rule for adding one\nA tool enters the stack when one person owns it and there is a written reason it exists. No owner means no cancellation either, which is how you end up with six of them.",
    "entries": [
      {
        "type": "decision",
        "project": "studio",
        "agent": "team",
        "summary": "One file host and one folder tree for everything, with the naming convention applied from the top. Anything living outside it, including things on a laptop desktop, counts as a copy and is not the file of record.",
        "ts": "2026-05-11T10:15:39.664Z"
      },
      {
        "type": "decision",
        "project": "studio",
        "agent": "team",
        "summary": "Turned down the all in one studio platform after a two week trial. It wants time tracking, invoicing, files, briefs and chat, and does all five at about 60 percent. Two weeks to switch, and our whole history would live somewhere we cannot export cleanly. Not worth it.",
        "ts": "2026-05-21T18:03:22.665Z"
      },
      {
        "type": "gotcha",
        "project": "bramblewell",
        "agent": "design",
        "summary": "The design tool kept an old brand colour alive as a shared library style after we had updated it locally, so two of us were working in slightly different greens for a week without noticing. Library updates are not automatic for anyone who has the file already open.",
        "ts": "2026-06-18T13:48:11.666Z"
      },
      {
        "type": "decision",
        "project": "studio",
        "agent": "accounts",
        "summary": "Cancelled the stock photography subscription. Four uses in a year, twelve payments.",
        "ts": "2026-07-02T09:07:53.667Z"
      },
      {
        "type": "convention",
        "project": "studio",
        "agent": "team",
        "summary": "No tool joins the stack without a named owner and one written line saying what it is for. The owner is also the person who cancels it, which turns out to be the part that never happens otherwise.",
        "ts": "2026-07-15T16:41:29.668Z"
      }
    ]
  },
  {
    "id": "contractor-handoff-kit",
    "title": "What a freelancer needs on day one",
    "body": "We bring in two or three freelancers a year. Every bad experience has been our fault, and always the same fault: we sent the work and not the context.\n\n## The kit\n1. The brief, including two directions we have already rejected and why. This is the part people leave out and it is the part that saves the week.\n2. Brand files, current, from the client folder rather than from an old job.\n3. The output spec: colour profile, stock, size, bleed, what the file is going to be used for.\n4. The naming convention and the folder they write into.\n5. One named person to ask, and the promise that asking is not a failure.\n\n## Access\nRead access to the client folder, write access only to their own subfolder. Not about trust, about being able to tell later which files came from where.\n\n## Paying them\nFreelancers are paid on our terms, 15 days, regardless of whether the client has paid us. If we cannot carry that, we cannot afford the freelancer, and it is better to know that before the work starts than after.",
    "entries": [
      {
        "type": "pattern",
        "project": "studio",
        "agent": "production",
        "summary": "Standing kit for anyone joining a job: brief with two rejected directions in it, current brand files pulled from the client folder, output spec, naming convention, the folder they write into, and one named person to ask. Assembling it takes about twenty minutes.",
        "ts": "2026-05-13T08:34:57.372Z"
      },
      {
        "type": "gotcha",
        "project": "bramblewell",
        "agent": "production",
        "summary": "A retoucher delivered a week of work in the wrong colour space because nobody sent the press profile. Entirely on us. The output spec is now in the kit and it is the first thing in the brief, not an attachment at the bottom of an email.",
        "ts": "2026-05-27T14:09:18.373Z"
      },
      {
        "type": "convention",
        "project": "studio",
        "agent": "team",
        "summary": "Freelancers get read access to the whole client folder and write access only to their own subfolder. It is not about trust, it is so that in six months we can tell which file came from whom without asking anybody to remember.",
        "ts": "2026-06-10T11:26:42.374Z"
      },
      {
        "type": "decision",
        "project": "studio",
        "agent": "accounts",
        "summary": "We pay freelancers on our terms, 15 days, whether or not the client has paid us yet. If a job cannot carry that, we cannot afford the freelancer on it. Passing a client's slow payment down to a one person business is the thing we complain about upstream.",
        "ts": "2026-06-26T15:53:06.375Z"
      },
      {
        "type": "gotcha",
        "project": "slatefield",
        "agent": "design",
        "summary": "A genuinely good illustrator was slow for two weeks because the brief had no examples of wrong. She was guessing at the boundary and correcting herself. Two rejected directions in the brief fixed it immediately, and now they are in every brief we write.",
        "ts": "2026-07-13T10:48:23.376Z"
      }
    ]
  },
  {
    "id": "weekly-planning-rhythm",
    "title": "The week: what we look at, and when we stopped looking",
    "body": "Four people in one room. The rhythm exists so that the room is not the only coordination mechanism.\n\n## Monday\nOne hour, everything in flight on the board, in order of what is closest to a client date. For each job: what moves this week, who is on it, and whether anything is blocked. Blockers get written on the job, not said out loud and forgotten.\n\n## The rest of the week\nNothing recurring. If a job needs a check in, that check in belongs to the job and gets scheduled by the person running it.\n\n## Friday afternoon\nUnbilled. Filing, archiving delivered work, fixing the thing that has been annoying us, learning something. It is the first thing that vanishes when a month gets busy, and the month after it vanishes is reliably worse than the month it saved. Treat it as booked work.\n\n## What we stopped\nThe daily standup. Reasoning is in the log below and it is worth reading before anyone suggests bringing it back, which they will.",
    "entries": [
      {
        "type": "decision",
        "project": "studio",
        "agent": "team",
        "summary": "Starting a daily fifteen minute standup at 9am. Everyone says what they are on and what is in the way. Copied from a studio we like the look of.",
        "ts": "2026-05-12T09:05:14.128Z"
      },
      {
        "type": "gotcha",
        "project": "studio",
        "agent": "team",
        "summary": "The standup turned into status theatre inside three weeks. Four people who sit in the same room all day do not need a meeting to know what the others are doing, and nobody wanted to be the one raising a blocker two days running, so blockers stopped being raised at all.",
        "ts": "2026-05-22T17:36:49.129Z"
      },
      {
        "type": "supersede",
        "project": "studio",
        "agent": "team",
        "summary": "Standup is dead. Replaced by one Monday planning hour across everything in flight, ordered by nearest client date, plus a written blocker line on the job card for anything stuck. Written blockers get picked up by whoever can clear them, which the spoken ones never did.",
        "ts": "2026-06-01T09:18:02.130Z",
        "supersedesIndex": 0
      },
      {
        "type": "convention",
        "project": "studio",
        "agent": "team",
        "summary": "Friday afternoon is unbilled and belongs to the studio: filing, archiving what shipped, fixing whatever is annoying us, learning something. It goes in the calendar as booked so that saying yes to work on a Friday is a visible choice.",
        "ts": "2026-06-19T16:24:37.131Z"
      },
      {
        "type": "gotcha",
        "project": "studio",
        "agent": "team",
        "summary": "Friday afternoon is the first thing to disappear in a busy month, and the month after it disappears is always worse than the month it rescued. June ate three of them and July started with two days of untangling filing that nobody had done.",
        "ts": "2026-07-10T15:57:11.132Z"
      }
    ]
  },
  {
    "id": "file-naming-convention",
    "title": "How files are named, and where the delivered ones live",
    "body": "Two things: names and locations. Neither is interesting and both have cost us real days.\n\n## The name\nclient_project_asset_v## and nothing else. Two digit version, always. No spaces, no initials, no client shorthand that a stranger cannot decode in a year. A date only goes in the name when the deliverable is genuinely dated, like a poster for a specific night.\n\nThe version number is the only truth about which file is newest. Words are not version control. If a file has to be marked, it gets a higher number.\n\n## Working versus delivered\nWorking files and delivered files never share a folder. On delivery the outgoing set is packaged, with fonts and linked images collected, and copied to an archive folder that we do not open again to edit. If it needs a change, it comes back out as a new version in the working folder.\n\n## Why the packaging matters\nAn archived working file with missing links is not an archive, it is a receipt for one. We found this out on a reprint eleven months later when the linked photography had moved twice.",
    "entries": [
      {
        "type": "convention",
        "project": "studio",
        "agent": "team",
        "summary": "Naming is client_project_asset_v## with a two digit version and no spaces. Dates only appear in the name when the deliverable itself is dated. The version number is the only claim about which file is newest that anybody is allowed to make.",
        "ts": "2026-05-08T13:29:46.795Z"
      },
      {
        "type": "gotcha",
        "project": "slatefield",
        "agent": "design",
        "summary": "Three files called final, final2 and final_USE_THIS, and the one that went to print was none of them. Twenty minutes of four people staring at timestamps. The word final is banned in a file name, including as a suffix, including when it really is the last one.",
        "ts": "2026-05-29T11:52:08.796Z"
      },
      {
        "type": "decision",
        "project": "studio",
        "agent": "production",
        "summary": "On delivery, the outgoing set is copied to a locked archive folder that we never edit again. Changes come back out as a new version in the working folder. Editing the delivered file in place means we can no longer answer the question of what the client actually received.",
        "ts": "2026-06-08T14:06:33.797Z"
      },
      {
        "type": "pattern",
        "project": "studio",
        "agent": "production",
        "summary": "Working files and delivered files never share a folder. When they do, someone eventually opens the wrong one at speed under a deadline, and it is always the person who was not on the job.",
        "ts": "2026-06-22T09:44:20.798Z"
      },
      {
        "type": "gotcha",
        "project": "bramblewell",
        "agent": "production",
        "summary": "A reprint request eleven months later found the archived working file with three missing links, because the photography folder had been reorganised twice since. The archive now takes a packaged copy with fonts and links collected, not the bare working file.",
        "ts": "2026-07-06T16:13:57.799Z"
      },
      {
        "type": "convention",
        "project": "studio",
        "agent": "team",
        "summary": "No initials, no in house shorthand, no abbreviations that need somebody from this year to decode. Names are written for the person who opens the folder in two years, and that person may not be one of us.",
        "ts": "2026-07-20T12:31:05.800Z"
      }
    ]
  },
  {
    "id": "font-licensing-rules",
    "title": "Fonts: what the licence actually lets us do",
    "body": "Type licensing is the one area where a cheerful mistake becomes a letter from a lawyer, so it gets rules.\n\n## Record it\nEvery project note carries a licence line for each typeface used: family, where it came from, what the licence covers, and how many seats. Written at the point of choosing, not at the point of delivering.\n\n## What a desktop licence is not\nA desktop licence does not cover a webfont. It does not cover embedding in an application. It does not cover sending the font file to the client's printer, even though the printer will ask, and asking is normal, and saying no feels obstructive. Send outlines or buy the printer a licence.\n\n## Whose name\nWhen a typeface is going to outlive our involvement, the licence is bought in the client's name, not ours. Otherwise their brand depends on our subscription staying paid, which is not a relationship either side signed up for.\n\n## Sketching counts\nA face that is free for personal use is not free in a logo sketch. Nobody intends to keep it, and then the sketch is the one the client falls in love with.\n\n## Default\nTwo families we hold broad licences for cover most work. Anything else gets a licence check before it appears in a presentation, not before it goes to print.",
    "entries": [
      {
        "type": "convention",
        "project": "studio",
        "agent": "design",
        "summary": "Every typeface a project uses gets a licence line in the project note at the moment it is chosen: family, source, what the licence covers, seat count. Written then, because at delivery nobody can remember which of the four candidates actually survived.",
        "ts": "2026-05-15T10:41:52.456Z"
      },
      {
        "type": "gotcha",
        "project": "fernpost",
        "agent": "design",
        "summary": "A desktop licence does not cover a webfont and it does not cover handing the file to a third party. Their developers asked for the font files to self host and we nearly just sent them. The webfont licence was a separate purchase and a separate seat count.",
        "ts": "2026-06-12T15:28:14.457Z"
      },
      {
        "type": "decision",
        "project": "studio",
        "agent": "team",
        "summary": "When a typeface will outlive our involvement, the licence is bought in the client's name and billed through, not held by us. Their brand should not depend on our subscription staying paid, and it makes the eventual handover to another studio clean rather than awkward.",
        "ts": "2026-06-23T11:09:38.458Z"
      },
      {
        "type": "gotcha",
        "project": "ridgehaul",
        "agent": "design",
        "summary": "A face that was free for personal use got into a logo sketch because it was already installed. It was the sketch the client liked. Redrawing the mark in a licensed face cost two days and made us look indecisive. Sketching counts as use.",
        "ts": "2026-07-08T14:52:26.459Z"
      },
      {
        "type": "decision",
        "project": "studio",
        "agent": "team",
        "summary": "Default to the two families we hold broad licences for. Anything outside them needs a licence check before it appears in front of a client, because once they have seen it the cost of the check has already been paid in goodwill.",
        "ts": "2026-07-21T09:36:44.460Z"
      }
    ]
  },
  {
    "id": "print-proofing-checklist",
    "title": "Proofing: what runs before a file leaves the studio",
    "body": "Nothing goes to a printer without this. It takes fifteen minutes and it has caught something roughly one time in four.\n\n## The checklist\n- Bleed present and correct for the finish, marks on, page size right.\n- Overprint and knockout checked in the output preview, not assumed.\n- Black build correct: rich black for large areas, single black for small type, and registration black used for nothing at all.\n- Image resolution checked at final placed size, not at native size.\n- Every linked file present and current.\n- Spelling read once forwards and once backwards. Backwards catches what your eye repairs.\n- Legal text checked against the version the client signed, not the version in the last file.\n\n## Who signs\nOne person proofs, a different person signs. Never the same pair twice in a row on the same client, because familiarity is exactly what stops you seeing it.\n\n## Screen is not a proof\nAnything above a short run gets a physical proof on the actual stock. On screen is a check for content, never for colour.\n\n## Light\nLook at the proof under the light the thing will live under. A label that sings under a daylight lamp can turn muddy under warm shop lighting, and the shop is where it has to work.",
    "entries": [
      {
        "type": "convention",
        "project": "studio",
        "agent": "production",
        "summary": "Standing preflight before any file leaves: bleed and marks, overprint in the output preview, black builds, image resolution at placed size, links present, spelling read forwards and backwards, legal text checked against the signed version rather than the last file.",
        "ts": "2026-05-18T08:22:31.930Z"
      },
      {
        "type": "gotcha",
        "project": "slatefield",
        "agent": "production",
        "summary": "Small type set in registration black instead of single black on a two colour job. The press operator caught it and phoned. We did not catch it, and we had looked at that file four times. Registration black is now checked explicitly rather than being covered by looking carefully.",
        "ts": "2026-06-01T12:14:09.931Z"
      },
      {
        "type": "gotcha",
        "project": "bramblewell",
        "agent": "production",
        "summary": "Spot varnish artwork went out with the varnish plate named two different things in two files. The finisher guessed, correctly, and mentioned it in passing weeks later. Special finishes get one spelled out plate name written in the job note and used everywhere.",
        "ts": "2026-06-15T16:47:52.932Z"
      },
      {
        "type": "pattern",
        "project": "studio",
        "agent": "team",
        "summary": "One person proofs, a different person signs, and not the same pair twice running on the same client. Familiarity with a file is what stops you seeing it, so the second reader is only useful if they are genuinely cold on the job.",
        "ts": "2026-06-29T10:19:26.933Z"
      },
      {
        "type": "decision",
        "project": "studio",
        "agent": "production",
        "summary": "Anything above a short run gets a physical proof on the real stock, billed to the job. On screen approval is for content only. We have twice signed off colour on a calibrated screen and twice been surprised, which is not a run of bad luck, it is the method being wrong.",
        "ts": "2026-07-10T13:41:08.934Z"
      },
      {
        "type": "gotcha",
        "project": "bramblewell",
        "agent": "design",
        "summary": "A proof is only meaningful under the light the product will sit under. The cider label read clean and cool under the studio lamp and went slightly grey under the warm lighting in the farm shop it was made for. We now check proofs under a warm lamp as well.",
        "ts": "2026-07-22T15:06:49.935Z"
      }
    ]
  },
  {
    "id": "press-color-profiles",
    "title": "Colour that survives contact with a press",
    "body": "Brand colour is not a number. It is a number per stock, and pretending otherwise is how a brand ends up with three greens.\n\n## Working profiles\nOne working profile per output class: coated stock, uncoated stock, screen. Named in the project note so a freelancer or a printer can be told in one line. Everything is tagged. An untagged file is the single most common cause of two people looking at different colours.\n\n## How brand colours are specified\nA spot reference plus a build for each stock, never one build for everything. Uncoated absorbs and the colour drops, so we specify a lighter build for uncoated instead of shipping the coated build and being disappointed in the same way every time.\n\n## The swatch drawer\nEvery brand colour, printed on every stock we have run it on, filed with the date and the stock name. It cost almost nothing and it ends arguments in about ten seconds, including arguments with ourselves.",
    "entries": [
      {
        "type": "decision",
        "project": "studio",
        "agent": "production",
        "summary": "One working profile per output class, coated, uncoated and screen, written into every project note by name. The previous approach of whatever the file arrived tagged with was not a decision, it was just the last person's default settings winning.",
        "ts": "2026-05-25T14:33:17.613Z"
      },
      {
        "type": "gotcha",
        "project": "bramblewell",
        "agent": "design",
        "summary": "The brand green came out different from two source files because one was tagged and one was not, so the untagged one was being interpreted with whatever the opening application felt like. Untagged is the enemy. Everything gets tagged even when it looks fine.",
        "ts": "2026-06-05T09:51:40.614Z"
      },
      {
        "type": "convention",
        "project": "studio",
        "agent": "design",
        "summary": "Brand colours are specified as a spot reference plus a separate build for each stock, not as one universal build. A brand guideline that gives a single set of numbers is describing a wish, not a colour.",
        "ts": "2026-06-19T11:37:22.615Z"
      },
      {
        "type": "gotcha",
        "project": "bramblewell",
        "agent": "production",
        "summary": "Uncoated stock ate the brand green by about a step and a half, and no amount of asking the printer to push it made it match the coated version. We now specify a deliberately lighter build for uncoated so the two read as the same colour rather than measuring the same.",
        "ts": "2026-07-03T16:08:54.616Z"
      },
      {
        "type": "pattern",
        "project": "studio",
        "agent": "production",
        "summary": "Physical swatch drawer: every brand colour printed on every stock we have run it on, filed with the date and the stock name on the back. Costs a few pounds a year and settles colour arguments faster than anything on a screen ever has.",
        "ts": "2026-07-17T10:12:36.617Z"
      }
    ]
  },
  {
    "id": "bramblewell-label-system",
    "title": "Bramblewell Cider: the label system and how it flexes",
    "body": "Bramblewell make six ciders and add one or two a year. The label is a system, not six designs.\n\n## Architecture\nOne layout for the range. Between varieties, two things change: the colour and the varietal mark. Everything else, the brand block, the illustrated frame, the legal panel, holds still. Somebody standing at a shelf should see one family and then pick a flavour.\n\n## Hierarchy\nThe variety name is the loudest element, above the brand. Tested at two metres in the shop they actually sell into. The brand is already doing its job through the frame and the colour, and shouting it twice made the range look like six unrelated products.\n\n## The legal panel\nBuilt to the widest legal text we have ever seen, plus a margin. When the alcohol content wording changed the panel needed 30 percent more room and there was none, which meant reflowing a design that was already approved.\n\n## Two masters\nCan and bottle are not the same artwork. The printable area on the can is shorter and the frame crops differently. Two masters, one system, and a change to the system means editing both. There is no shortcut here and every attempt to find one has produced a mismatched pair.\n\n## New varieties\nA new variety starts from the master spec, never from a copy of the last label file. Copies inherit whatever was bodged into the last one at press.",
    "entries": [
      {
        "type": "decision",
        "project": "bramblewell",
        "agent": "design",
        "summary": "One label architecture for the whole range. Between varieties only the colour and a commissioned illustrated band change. Everything structural holds still so the range reads as a family on shelf and a new variety does not need a new design conversation.",
        "ts": "2026-05-19T13:16:28.287Z"
      },
      {
        "type": "decision",
        "project": "bramblewell",
        "agent": "design",
        "summary": "The variety name is the loudest thing on the label, larger than the brand. Tested by pinning proofs at two metres, which is roughly where someone stands in the aisle. With the brand loudest the six products stopped looking like a range and started looking like a repeat.",
        "ts": "2026-06-02T16:42:05.288Z"
      },
      {
        "type": "gotcha",
        "project": "bramblewell",
        "agent": "production",
        "summary": "The legal panel grew about 30 percent when the alcohol content wording changed, and the layout had no slack, so an approved design had to be reflowed under a print deadline. Panels are now built to the widest legal text we have seen plus a margin.",
        "ts": "2026-06-11T14:23:47.289Z"
      },
      {
        "type": "supersede",
        "project": "bramblewell",
        "agent": "design",
        "summary": "The commissioned illustration per variety does not scale. Each new flavour meant a commission, a fee and three weeks of lead time for a product the client decides on in a fortnight. Replaced with a fixed illustrated frame plus a small varietal mark we can draw in a day.",
        "ts": "2026-06-30T09:34:12.290Z",
        "supersedesIndex": 0
      },
      {
        "type": "convention",
        "project": "bramblewell",
        "agent": "design",
        "summary": "A new variety is built from the master spec, never by copying the last label file. Copies carry forward whatever got bodged in at press on the previous run, and two generations later nobody knows which parts were deliberate.",
        "ts": "2026-07-07T17:19:33.291Z"
      },
      {
        "type": "gotcha",
        "project": "bramblewell",
        "agent": "production",
        "summary": "Can and bottle are not one artwork. The can's printable area is shorter and the illustrated frame crops at the top, which we discovered on a proof. Two masters now, and any change to the system has to be made in both or the pair drifts apart.",
        "ts": "2026-07-21T11:45:58.292Z"
      }
    ]
  },
  {
    "id": "bramblewell-print-run",
    "title": "Bramblewell: the first full run, and what press taught us",
    "body": "The first run of the redrawn range. Everything below came out of being in the room.\n\n## Die lines\nAsk the label supplier for the die line by email and write the date on it. The one on their website was two versions old, which we found out by comparing it to the physical label in our hand.\n\n## Press checks\nWe attend the first press check of any new range, on our own time if the fee did not include it. The first one always teaches something that no amount of proofing catches, and after that we can usually sign off remotely with confidence.\n\n## What the first check caught\nThe cream in the label read pink on coated stock under the press lights, and read correctly in daylight at the door. Pulled the magenta at press, and the corrected build went straight back into the master file the same afternoon. A fix made at press that does not go back into the master is a fix you make again next year.\n\n## After the run\nThe actual printed piece goes into the archive next to the file, with the date, the stock and the press written on the back. It becomes the reference for the reprint, and it is the only honest record of what the colour really did.\n\n## Who owns the printer\nThe client holds the relationship with the printer and pays them directly. We hold the files and the specification.",
    "entries": [
      {
        "type": "gotcha",
        "project": "bramblewell",
        "agent": "production",
        "summary": "The label supplier's die line on their own website was two versions out of date. We caught it by holding the physical label against the drawing. Always ask for the die line by email, and write the date you received it on the file.",
        "ts": "2026-06-26T09:28:41.054Z"
      },
      {
        "type": "decision",
        "project": "bramblewell",
        "agent": "production",
        "summary": "We attend the first press check for any new range, on our own time if the fee did not cover it. It has never once been a wasted morning, and after the first check we can usually approve the rest of the range remotely without worrying.",
        "ts": "2026-07-01T15:33:19.055Z"
      },
      {
        "type": "gotcha",
        "project": "bramblewell",
        "agent": "production",
        "summary": "Saturday press check: the cream read pink on coated stock under the press lights and read fine in daylight by the door. Pulled the magenta on press, then put the corrected build back into the master file the same afternoon. A press fix that stays on press is not a fix.",
        "ts": "2026-07-04T08:16:05.056Z"
      },
      {
        "type": "pattern",
        "project": "bramblewell",
        "agent": "production",
        "summary": "After every run the actual printed piece is filed in the archive beside the artwork, with the date, the stock and the press written on the back. It is the reference for the reprint and the only truthful record of what the colour did on the day.",
        "ts": "2026-07-13T17:02:44.057Z"
      },
      {
        "type": "decision",
        "project": "bramblewell",
        "agent": "accounts",
        "summary": "The client holds the printer relationship and pays the printer directly. We hold the files and write the specification. We spent a week chasing an invoice that was never ours, and being in the middle of somebody else's money is a job nobody is paying us for.",
        "ts": "2026-07-17T12:47:30.058Z"
      }
    ]
  },
  {
    "id": "ridgehaul-rebrand-scope",
    "title": "Ridgehaul: what the rebrand covers, and who is allowed to approve it",
    "body": "Regional haulage company, thirty vehicles, a mark from the eighties that nobody has the artwork for. The work went fine. The scope and the approvals nearly did not.\n\n## In scope\nIdentity, fleet livery, and the document set. Website explicitly out, named in the exclusions, quoted separately later at a proper price rather than folded into the old fee.\n\n## The document set\nSix templates. We wrote the words document set and they read forty. Neither of us was being difficult, the phrase just does not mean anything. Deliverables are counted now, in the proposal, as a list.\n\n## Approvals\nThe mark had to be signed off before livery started. We got that sign off from a named contact who turned out not to have the authority, and the decision reopened three weeks later at a level we had never met.\n\nSo: the person who can say yes is in the room at the first presentation, or we do not present. Not a preference, a condition of the phase.\n\n## Every presentation ends in writing\nA short summary sent the same day that begins with what was agreed. Not minutes. Three or four lines, decisions only, so that when the question comes back there is a dated record that everyone received and nobody objected to.",
    "entries": [
      {
        "type": "decision",
        "project": "ridgehaul",
        "agent": "team",
        "summary": "Scope is identity, fleet livery and the document set. Website is explicitly out and named in the exclusions, because they have an internal person who will want to do it and a half owned website is worse for both of us than none.",
        "ts": "2026-05-21T11:24:36.741Z"
      },
      {
        "type": "gotcha",
        "project": "ridgehaul",
        "agent": "team",
        "summary": "Document set meant six templates to us and forty to them, and both readings were reasonable. Nobody was being difficult, the phrase simply carries no quantity. Deliverables are counted as a list in the proposal now, or the words do not go in at all.",
        "ts": "2026-06-09T13:57:22.742Z"
      },
      {
        "type": "decision",
        "project": "ridgehaul",
        "agent": "team",
        "summary": "Phase gate: no livery work starts until the mark is signed off by a named person rather than by a meeting. Committees approve things nobody is accountable for, and then the approval evaporates the moment somebody senior frowns at it.",
        "ts": "2026-06-18T09:41:15.743Z"
      },
      {
        "type": "supersede",
        "project": "ridgehaul",
        "agent": "team",
        "summary": "The named person did not actually hold the authority, and the mark reopened three weeks later at a level we had never met. Named is not enough. The person who can say yes attends the first presentation or we do not present, and that is now a condition of the phase.",
        "ts": "2026-07-02T14:29:48.744Z",
        "supersedesIndex": 2
      },
      {
        "type": "convention",
        "project": "studio",
        "agent": "production",
        "summary": "Every presentation ends with a written summary sent the same day, opening with what was agreed. Three or four lines, decisions only, no minutes. When a decision comes back six weeks later there is a dated record everybody received and nobody argued with at the time.",
        "ts": "2026-07-10T11:16:52.745Z"
      },
      {
        "type": "decision",
        "project": "ridgehaul",
        "agent": "accounts",
        "summary": "The website they cut from scope came back as a want, and we quoted it separately at a current price instead of absorbing it into the identity fee. Doing it inside the old number would have taught them that the exclusions list is decorative.",
        "ts": "2026-07-20T16:38:27.746Z"
      }
    ]
  },
  {
    "id": "ridgehaul-fleet-livery",
    "title": "Ridgehaul: livery that still reads at fifty metres",
    "body": "Thirty vehicles, four body types, applied by a vinyl fitter we do not employ. The constraints are physical and they win.\n\n## Design the biggest thing first\nThe mark that looked confident on a business card vanished on the side of a trailer. We had been designing up. Now the trailer is the first application drawn and the card is the last, and the mark is judged from a photograph taken across a car park.\n\n## Two elements, one colour break\nName and symbol, and a single break between colours. Every extra element is another cut, another weeded piece of vinyl, another chance for the fitter to make a judgement call at seven in the morning in the rain. Complexity does not survive application, it just gets quietly simplified by somebody else.\n\n## Measure a real vehicle\nThe fitter's template and the manufacturer's drawing disagreed about door proportions, and the fitter's was right because it came off an actual van. Get a tape measure on one of the client's own vehicles before finalising a sheet.\n\n## The reference photograph\nEvery livery sheet ships with a photograph of the first applied vehicle. That photograph, not the drawing, is what the fitter matches for every vehicle after. It has removed more back and forth than any amount of dimensioning.\n\n## Specifying vinyl\nBy finish and by a colour reference viewed on the actual substrate. Never by the screen colour, and never by the coated build, because vinyl on white and vinyl on a dark cab are not the same colour.",
    "entries": [
      {
        "type": "gotcha",
        "project": "ridgehaul",
        "agent": "design",
        "summary": "The mark that worked beautifully on a business card disappeared on a trailer seen across a yard. We had been designing upward from the smallest application. The largest application is now the first thing drawn and it is judged from a photograph, not on a screen.",
        "ts": "2026-06-22T15:11:43.366Z"
      },
      {
        "type": "decision",
        "project": "ridgehaul",
        "agent": "design",
        "summary": "Livery is two elements and one colour break. Anything more costs money in vinyl, adds cuts, and gets simplified anyway by whoever is applying it at seven in the morning. Better that we make that simplification deliberately than that a fitter makes it for us.",
        "ts": "2026-06-30T10:37:09.367Z"
      },
      {
        "type": "gotcha",
        "project": "ridgehaul",
        "agent": "production",
        "summary": "The fitter's template and the manufacturer's drawing disagreed on door proportions, and the fitter was right because his came off a real van. Measure one of the client's actual vehicles before finalising any sheet, even when a drawing exists.",
        "ts": "2026-07-07T13:24:51.368Z"
      },
      {
        "type": "convention",
        "project": "ridgehaul",
        "agent": "production",
        "summary": "Every livery sheet ships with a photograph of the first applied vehicle, and that photograph is the reference for all the others. It has settled more questions than the dimensioned drawing, because a fitter compares what he can see rather than reading a measurement.",
        "ts": "2026-07-14T09:49:26.369Z"
      },
      {
        "type": "pattern",
        "project": "ridgehaul",
        "agent": "design",
        "summary": "Vinyl is specified by finish plus a colour reference viewed on the real substrate. The same vinyl over a white panel and over a dark cab are not the same colour, and specifying from the screen or from the coated print build guarantees an argument on delivery day.",
        "ts": "2026-07-21T15:53:12.370Z"
      }
    ]
  },
  {
    "id": "fernpost-design-system",
    "title": "Fernpost: building the product design system from real screens",
    "body": "Fernpost is a five person software company. They had a product and no system, and they wanted a component library. We built the system out of the three screens they ship most, which was the right call and not what was asked for.\n\n## Built from what exists\nAn abstract component list is a wish list. We took the three screens their users actually live in, designed those properly, and let the components fall out of the work. Everything in the library got there by being needed twice.\n\n## Spacing\nA spacing scale, and one only. It started at four steps because four covers ninety percent of a marketing page. It did not survive their data tables, and the fix is in the log rather than pretending the first version was right.\n\n## Where it lives\nIn their repository, not in our design tool. If the source of truth lives with us, the system dies the month our engagement ends. We keep an editable copy so we can work, but the version in their code is the one that counts, and when the two disagree the code is right.\n\n## Colour naming\nTokens are named by role and never by hue: surface, surface raised, text muted, accent. When their brand green changed in July, nothing broke and nothing needed renaming. A token called green that is now blue is worse than no system at all.\n\n## Ask about the grid first\nWe drew a library their framework could not build without fighting it. One question at the start would have saved a week.",
    "entries": [
      {
        "type": "decision",
        "project": "fernpost",
        "agent": "design",
        "summary": "Build the system out of the three screens they actually ship rather than from an abstract component list. A component earns its place by being needed twice in real work. The list they asked for had eleven things on it that no screen of theirs uses.",
        "ts": "2026-06-08T10:52:14.902Z"
      },
      {
        "type": "convention",
        "project": "fernpost",
        "agent": "design",
        "summary": "One spacing scale, four steps. If a layout needs a fifth value it is a layout problem and not a scale problem, and adding the value hides the mistake instead of fixing it.",
        "ts": "2026-06-16T16:31:47.903Z"
      },
      {
        "type": "gotcha",
        "project": "fernpost",
        "agent": "design",
        "summary": "We drew a library their front end framework could not build without fighting its own grid. A week of rework, and one question at the kickoff would have avoided all of it. Ask what the grid is, in numbers, before drawing a single screen.",
        "ts": "2026-06-24T08:47:35.904Z"
      },
      {
        "type": "decision",
        "project": "fernpost",
        "agent": "team",
        "summary": "The system is documented in their repository, not in our design tool. We keep an editable copy to work in, but the version in their code is authoritative and when the two disagree the code wins. A system that lives with the studio dies when the studio leaves.",
        "ts": "2026-07-06T11:58:22.905Z"
      },
      {
        "type": "supersede",
        "project": "fernpost",
        "agent": "design",
        "summary": "Four spacing steps did not survive their data tables, where every row was either cramped or wasteful. Now six steps, with the two smallest marked as dense only and not for use in page layout. Naming the exception kept it from leaking into everything else.",
        "ts": "2026-07-14T14:16:39.906Z",
        "supersedesIndex": 1
      },
      {
        "type": "convention",
        "project": "fernpost",
        "agent": "design",
        "summary": "Colour tokens are named by role, never by hue. Surface, surface raised, text muted, accent. Their brand green shifted in July and not one name had to change. A token called green that is now blue costs more than having no tokens at all.",
        "ts": "2026-07-22T09:53:08.907Z"
      }
    ]
  },
  {
    "id": "fernpost-dev-handoff",
    "title": "Fernpost: handing design over to the developers",
    "body": "Handoff is where good design work goes to be misunderstood. These are the things that fixed it.\n\n## A handoff is a conversation\nA link to a file is not a handoff. Thirty minutes of walking through it together surfaces more than a week of comments, and it is the only way we find out what is expensive to build before it is drawn.\n\n## Freeze and name the version\nDevelopers were building from a file we had edited underneath them. Now a version is frozen, named, and the name is stated in writing: this build is against v07. Anything after that is the next release, not a correction they should be watching for.\n\n## States are part of the design\nEmpty, loading, error and too much content. If those are not drawn, the screen is not designed, it is illustrated. The developer will invent them otherwise, at the end of a sprint, under time pressure.\n\n## Real content only\nWe designed a list against invented copy of even length, and their actual records include one customer name of sixty characters and several with none at all. Get real records out of their database before drawing anything that repeats.\n\n## One thread per screen\nQuestions go in a single thread per screen, and the answer is written back into the spec the same day. Otherwise the truth is spread across four conversations and the spec quietly becomes fiction.",
    "entries": [
      {
        "type": "pattern",
        "project": "fernpost",
        "agent": "design",
        "summary": "A handoff is a thirty minute conversation plus a written spec, never a link to a file. The conversation is where we learn which piece is expensive to build, and that is worth more than anything we would have found out later in comments.",
        "ts": "2026-06-19T11:42:55.175Z"
      },
      {
        "type": "gotcha",
        "project": "fernpost",
        "agent": "design",
        "summary": "Their developers spent two days building against a file we had edited underneath them. Freeze the version, give it a number, and say in writing which number is being built. Anything after that is the next release, not a correction they are supposed to notice.",
        "ts": "2026-07-01T09:14:28.176Z"
      },
      {
        "type": "decision",
        "project": "fernpost",
        "agent": "design",
        "summary": "A screen is not designed until the empty, loading, error and overflow states exist. Without them the developer invents them at the end of a sprint under pressure, and those inventions are what the user actually meets on a bad day.",
        "ts": "2026-07-08T16:35:41.177Z"
      },
      {
        "type": "gotcha",
        "project": "fernpost",
        "agent": "design",
        "summary": "We designed a list against invented copy of tidy even lengths. Their real records include a sixty character company name and a batch with no name at all. Pull real rows out of their database before drawing anything that repeats down a page.",
        "ts": "2026-07-15T12:08:19.178Z"
      },
      {
        "type": "convention",
        "project": "fernpost",
        "agent": "team",
        "summary": "Developer questions live in one thread per screen, and the answer gets written back into the spec the same day it is given. Answers that only exist in a chat message are answers that have to be given again in three weeks, differently.",
        "ts": "2026-07-23T10:44:52.179Z"
      }
    ]
  },
  {
    "id": "slatefield-poster-program",
    "title": "Slatefield Arts: the poster program",
    "body": "A hundred and forty seat venue with a show most weeks and no budget for a bespoke poster each time. The answer is a program, not a series of posters.\n\n## The frame\nOne grid, one typeface, one fixed date block, and a changing image. The point is that somebody walking past on a Tuesday recognises it as Slatefield before they read a word, even though the show is different from last week.\n\n## The date block\nFixed component, bottom left, same size every time. It kept drifting while we were designing around images, and it is the thing people actually stop for. Nailing it down made the whole program calmer.\n\n## Physical constraints\nTheir in house printer trims inconsistently by up to three millimetres. Nothing important sits within ten millimetres of the edge, ever. This is not a guideline, it is a property of the machine in their office.\n\n## Design at size, check small\nDesigned at A3, checked at thumbnail, because most people meet the poster as an image on a phone in a listings post. If it does not survive being sixty pixels wide it does not work, however good it looks pinned to the wall.\n\n## Copy comes from them\nShow times are copied from the venue's own listing text, never retyped from an email. Two posters went out with the wrong start time before that rule existed.",
    "entries": [
      {
        "type": "decision",
        "project": "slatefield",
        "agent": "design",
        "summary": "Poster program rather than individual posters: one grid, one typeface, a fixed date block, and a changing image. A venue with a show most weeks cannot afford a new idea every time, and a recognisable frame does more for them than seven unrelated good posters would.",
        "ts": "2026-05-13T12:47:23.528Z"
      },
      {
        "type": "gotcha",
        "project": "slatefield",
        "agent": "production",
        "summary": "The venue's own printer trims inconsistently by up to three millimetres, which we found by measuring a stack of the previous season. Nothing important goes within ten millimetres of the edge. It is a property of their machine, not a preference we can design around.",
        "ts": "2026-06-05T15:19:36.529Z"
      },
      {
        "type": "pattern",
        "project": "slatefield",
        "agent": "design",
        "summary": "Design at A3, check at thumbnail size, because most people meet the poster as an image on a phone in a listings post rather than on a wall. Anything that dies at sixty pixels wide gets reworked no matter how well it holds up printed.",
        "ts": "2026-06-12T09:32:48.530Z"
      },
      {
        "type": "decision",
        "project": "slatefield",
        "agent": "design",
        "summary": "The date and time block is a fixed component in a fixed position at a fixed size. It had been moving to suit each image, and it is the single thing passers by stop for. Freezing it made every poster in the program easier to lay out, not harder.",
        "ts": "2026-06-23T14:55:07.531Z"
      },
      {
        "type": "gotcha",
        "project": "slatefield",
        "agent": "production",
        "summary": "Two posters went out with the wrong start time, both retyped from an email thread rather than taken from the listing. Show copy is now copied from the venue's own listings text and checked against the ticket page by one named person before anything is printed.",
        "ts": "2026-07-09T16:27:44.532Z"
      },
      {
        "type": "convention",
        "project": "slatefield",
        "agent": "production",
        "summary": "Every poster is filed by show date so the season can be reviewed as a set at the end of the year. Looking at forty of them together is the only way to see that the program has drifted, and it always has drifted.",
        "ts": "2026-07-17T13:04:16.533Z"
      }
    ]
  },
  {
    "id": "work-we-turned-down",
    "title": "Work we said no to, and the reasoning at the time",
    "body": "The hardest thing to remember later is why we did not do something, because there is no project folder for it. So it goes here, with the reasoning as it was on the day, not as it looks now.\n\n## The pattern in the noes\nAlmost every job we regret taking had one of these three signals, and we have never once been surprised by which:\n1. A mark with no system behind it, priced as a mark. It comes back as unpaid support forever, because the client will need it in eleven formats and there is no document telling them what to do.\n2. Three approvers and no named decision maker. We have never finished one of these on budget.\n3. Any single client above roughly half our income. They stop being a client and start being an employer who sets our prices and our calendar.\n\n## How we say no\nWith a recommendation of somebody else who would be good at it, and with a plain statement of what we would charge to do it properly. Both cost nothing and both have come back to us later as work.\n\n## Why this note exists at all\nThe reasoning above is obvious in a good month and very hard to hold onto in a thin one. That is exactly when it gets read.",
    "entries": [
      {
        "type": "decision",
        "project": "studio",
        "agent": "team",
        "summary": "Turned down a logo only job at about a third of our rate. Not really about the money. A mark with no system behind it comes back as unpaid support for years, because they will need it in eleven formats and there is no document that tells them anything.",
        "ts": "2026-05-14T17:21:38.649Z"
      },
      {
        "type": "decision",
        "project": "studio",
        "agent": "team",
        "summary": "Said no to a job with three approvers and nobody named as the decision maker. Every one of these we have taken has run over, and the overrun is never the design work, it is the fourth round of showing the same thing to a different person.",
        "ts": "2026-06-15T10:08:24.650Z"
      },
      {
        "type": "decision",
        "project": "studio",
        "agent": "team",
        "summary": "Passed on a retainer that would have been around 60 percent of our income. Writing the reasoning down while it still stings: a client that size sets our prices and our calendar, and the day they restructure we have no studio, we have a redundancy.",
        "ts": "2026-06-29T14:46:11.651Z"
      },
      {
        "type": "gotcha",
        "project": "studio",
        "agent": "team",
        "summary": "We said no to a small piece of work and lost a much larger project four months later, because the small one had been an audition nobody described as an audition. A flat no with no alternative in it reads as a closed door even when it is only a full calendar.",
        "ts": "2026-07-16T15:32:57.652Z"
      },
      {
        "type": "convention",
        "project": "studio",
        "agent": "team",
        "summary": "Every no gets written here with its reason, and every no comes with a recommendation of someone else plus what we would charge to do it properly. The reasons repeat, and the pressure to forget them is highest in exactly the month when money is thin.",
        "ts": "2026-07-24T11:19:43.653Z"
      }
    ]
  },
];

/** One suggested edit left pending so review/Inbox has something to show. */
export const DEMO_PENDING_EDIT = {
  id: "print-proofing-checklist",
  proposer: "production",
  addition:
    "## Suggested: barcode check\n\nAdd a barcode line to the checklist. The Bramblewell reprint went out with the barcode scaled to 92 percent to fit the panel, which still scanned in the studio and failed twice at the till in the farm shop. Proposing: barcodes are never scaled below 95 percent, always sit on a light ground with the quiet zone intact, and get scanned off the physical proof rather than off the screen. Two minutes, and the failure mode is a product that cannot be sold.",
};
