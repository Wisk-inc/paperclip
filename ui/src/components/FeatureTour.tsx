import { useCallback, useEffect, useRef, useState } from "react";
import {
  Boxes,
  Brain,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CodeXml,
  FolderSync,
  History,
  House,
  Inbox,
  MessagesSquare,
  Plug,
  Repeat,
  Rocket,
  Sparkles,
  SquareTerminal,
  Users,
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Mascot, type MascotPose } from "@/components/mascot/Mascot";
import { ProgressBar } from "@/components/ui/progress-bar";
import { haptic } from "@/lib/haptics";
import { FEATURE_TOUR_EVENT, featureTourPending, markFeatureTourDone } from "@/lib/feature-tour";
import { useNavigate } from "@/lib/router";

interface TourStop {
  icon: typeof House;
  title: string;
  what: string;
  why: string;
  /** How to use it, step by step, in the words on the buttons. */
  steps: string[];
  /** Where "Open" goes; none for the welcome and finish cards. */
  to?: string;
  pose: MascotPose;
}

/** A welcome, every section in the order the app lays them out, and a send-off. */
export const TOUR_STOPS: TourStop[] = [
  {
    icon: Sparkles, title: "Welcome to Automa", pose: "cheering",
    what: "Automa runs a team of AI agents for you. You give them work in plain words; they plan it, do it, and check in when they need you.",
    why: "This tour shows each part of the app and exactly how to use it. It takes about two minutes, and you can skip it anytime.",
    steps: ["Swipe or tap Next to go through each part", "Tap Open on any card to jump straight there", "Come back to this tour from your profile: Take the tour"],
  },
  {
    icon: House, title: "Home", pose: "cheering", to: "/dashboard",
    what: "Your day at a glance: what needs you, who is working, and what it has cost this month.",
    why: "Open the app, read one screen, and know whether anything is waiting on you.",
    steps: ["Needs you lists approvals and questions from agents", "Agents shows who is working on what right now", "Usage this month shows spend, tokens and agent time"],
  },
  {
    icon: MessagesSquare, title: "Chats", pose: "excited", to: "/chats",
    what: "Talk to an agent like a teammate. Send text, photos and files; replies and the agent's thinking stream in live.",
    why: "The fastest way to hand off work: say it, and the agent turns it into tasks.",
    steps: [
      "Open Chats and pick an agent, or start a new chat",
      "Type what you need, or attach a photo or file with the paperclip",
      "Type / for commands: /plan, /model, /new, /help",
      "Tap the agent's picture at the top for its model, thinking depth and settings",
    ],
  },
  {
    icon: Brain, title: "Models and thinking", pose: "thinking", to: "/chats",
    what: "Each agent runs on a model you choose (Claude, GPT, Gemini, Kimi and more) and thinks as long as you let it.",
    why: "Quick answers for small things, deep thinking for hard problems, and you decide what each costs.",
    steps: [
      "In a chat, tap the agent's picture, then AI",
      "Change sets the model; Thinking goes from Quick to Max",
      "Claude agents can use the Anthropic API with your key, which works on phones too",
    ],
  },
  {
    icon: CircleCheck, title: "Tasks", pose: "thinking", to: "/issues",
    what: "Everything the agents are doing, each one a thread you can read, steer, and approve.",
    why: "Nothing happens silently. Every piece of work has a page, an owner, and a history.",
    steps: ["Tap + to create a task and assign it to an agent", "Open a task to read the agent's progress and reply to it", "Change status or reassign it from the task page"],
  },
  {
    icon: Inbox, title: "Inbox and Approvals", pose: "excited", to: "/inbox",
    what: "Decisions waiting on you: hires, budgets, plans, and anything an agent got stuck on.",
    why: "Agents never spend or hire without a yes from you. This is where you say it.",
    steps: ["The bell shows how many things wait on you; tapping it clears the count", "Open an approval and tap Approve or Reject", "Answer an agent's question right in the thread"],
  },
  {
    icon: Users, title: "Agents", pose: "cheering", to: "/agents",
    what: "Your team. Each agent has a role, a model, a system prompt, a budget, and a manager.",
    why: "Give a role once; the agent keeps to it on every task. Pause or change it anytime.",
    steps: ["Tap New agent, pick how it runs, name it and give it a role", "Open an agent to edit its system prompt, model or budget", "Org shows who reports to whom; drag to rearrange"],
  },
  {
    icon: Repeat, title: "Projects and Routines", pose: "thinking", to: "/projects",
    what: "Projects group tasks under one goal. Routines run work on a schedule, like a daily summary.",
    why: "Set the goal, pick the rhythm, and the work keeps happening while you are away.",
    steps: ["Create a project for a goal and add tasks to it", "In Routines, pick an agent, write the instruction, choose how often", "Each routine run shows up as a task you can read"],
  },
  {
    icon: Boxes, title: "Skills and Connectors", pose: "excited", to: "/skills",
    what: "Skills are what agents know how to do. Connectors are the apps they can reach: GitHub, Slack, Gmail and more.",
    why: "Add a skill or a connector and every agent can use it from the next run.",
    steps: ["Browse Skills and tap one to add it", "In Connectors, connect an app with its sign-in or key", "Agents pick them up on their next run"],
  },
  {
    icon: CodeXml, title: "App Studio", pose: "cheering", to: "/studio",
    what: "Build, run and share apps from your phone with an AI pair that writes the code and fixes what breaks.",
    why: "Describe it, see it run, send a link. Your API key powers it; the files stay on your device.",
    steps: [
      "Tap New app, pick a language and name it",
      "In the AI tab, describe what to build; the bar shows what it is doing",
      "Tap Run to start it, then Preview to try it",
      "Checkpoints let you undo any AI change",
    ],
  },
  {
    icon: FolderSync, title: "Files", pose: "thinking", to: "/device-files",
    what: "Share a folder on this phone with your agents, and get the files they make back here.",
    why: "Photos, documents, results: they move between you and the agents without a laptop.",
    steps: ["Pick a folder to share", "Agents read from it and save results back", "Open a result right from the list"],
  },
  {
    icon: History, title: "Audit", pose: "excited", to: "/activity",
    what: "Everything that happened: activity, runs, costs, budgets, and a timeline you can scroll.",
    why: "When you wonder why something happened, the answer is here, with who did it and when.",
    steps: ["Filter by agent or by kind of event", "Open a run to see what the agent did, step by step", "Costs breaks spending down by agent and model"],
  },
  {
    icon: Plug, title: "API keys and spending", pose: "cheering", to: "/company/settings/api-keys",
    what: "One place for your keys, what is left on them, and a monthly spending limit.",
    why: "Add a key once; agents, chats and App Studio all use it. Set a limit and nothing overspends.",
    steps: [
      "Add a key for Anthropic, OpenAI, OpenRouter or xAI",
      "Each key shows what Automa spent this month (and the credit left on OpenRouter)",
      "Set a monthly limit: at the limit, agents and App Studio stop until you raise it",
    ],
  },
  {
    icon: SquareTerminal, title: "Terminals", pose: "cheering", to: "/terminals",
    what: "Open a real coding terminal on this device — Claude Code, Codex, Gemini CLI, OpenCode — with its full terminal UI, and use it right here.",
    why: "The whole desktop tool, on your phone. Wire one to an agent so it works with the agent's key.",
    steps: [
      "Open Terminals and tap a tool",
      "The first time, Automa installs it (and a small Linux layer on a phone)",
      "Use the key bar for Esc, Tab, Ctrl-C and the arrows",
      "From an agent's settings, \"Open a terminal as this agent\"",
    ],
  },
  {
    icon: Boxes, title: "App Inspector", pose: "thinking", to: "/app-inspector",
    what: "Pick an app on your phone to decode its manifest, resources and code, read the code as Java, ask Claude to explain any file, edit, and rebuild a signed APK to your Downloads.",
    why: "Look inside an app you made or are authorized to analyze, with Claude to help you read it.",
    steps: [
      "Tap an app in the grid (or choose an APK file), then Decode",
      "Watch each step; Java code appears once jadx finishes",
      "Open any file and tap Explain with Claude",
      "Edit in Files, Save, then Rebuild and Save to Downloads",
    ],
  },
  {
    icon: Rocket, title: "You're ready", pose: "excited", to: "/chats",
    what: "Start with one thing you want done this week. Tell an agent in Chats, and watch it plan and get going.",
    why: "Small, real tasks teach your agents (and you) the fastest.",
    steps: ["Open Chats and say what you need", "Approve its plan in the Inbox", "Check Home tomorrow to see what got done"],
  },
];
const STOPS = TOUR_STOPS;

/**
 * The feature tour: a card per section with what it is, why it matters, how
 * to use it step by step, a link straight into it, and a Skip at every step.
 * Opens once after sign-up and onboarding, and from "Take the tour" in the
 * account sheet.
 */
export function FeatureTour() {
  const [open, setOpen] = useState(() => featureTourPending());
  const [index, setIndex] = useState(0);
  const navigate = useNavigate();
  const touch = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const onRequest = () => {
      setIndex(0);
      setOpen(true);
    };
    window.addEventListener(FEATURE_TOUR_EVENT, onRequest);
    return () => window.removeEventListener(FEATURE_TOUR_EVENT, onRequest);
  }, []);

  const finish = useCallback(() => {
    markFeatureTourDone();
    setOpen(false);
  }, []);

  const stop = STOPS[index]!;
  const last = index === STOPS.length - 1;
  const Icon = stop.icon;
  const go = (delta: number) => {
    const next = index + delta;
    if (next < 0 || next >= STOPS.length) return;
    haptic("tick");
    setIndex(next);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : finish())}>
      <DialogContent
        className="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-md"
        showCloseButton={false}
        data-testid="feature-tour"
        onPointerDown={(event) => {
          touch.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerUp={(event) => {
          const start = touch.current;
          touch.current = null;
          if (!start) return;
          const dx = event.clientX - start.x;
          if (Math.abs(dx) > 60 && Math.abs(event.clientY - start.y) < 50) go(dx < 0 ? 1 : -1);
        }}
      >
        <div className="flex items-center justify-between px-4 pt-3">
          <span className="text-xs font-medium text-muted-foreground" aria-live="polite">
            {index + 1} of {STOPS.length}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={finish} data-testid="feature-tour-skip">
            {last ? "Close" : "Skip tour"}
          </Button>
        </div>
        <div className="flex min-h-0 flex-col items-center gap-3 overflow-y-auto px-6 pt-2 pb-4 text-center" key={stop.title}>
          <div className="relative">
            <Mascot pose={stop.pose} size="md" />
            <span className="absolute -right-2 -bottom-1 flex size-9 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-sm">
              <Icon className="size-4" aria-hidden="true" />
            </span>
          </div>
          <DialogTitle className="text-lg font-semibold">{stop.title}</DialogTitle>
          <DialogDescription className="text-sm leading-6 text-foreground/90">{stop.what}</DialogDescription>
          <p className="rounded-lg bg-muted/60 px-3 py-2 text-sm leading-6 text-muted-foreground">
            <span className="font-medium text-foreground">Why it matters: </span>
            {stop.why}
          </p>
          <ol className="w-full space-y-1.5 text-left" aria-label={`How to use ${stop.title}`} data-testid="feature-tour-steps">
            {stop.steps.map((step, number) => (
              <li key={step} className="flex gap-2.5 text-sm leading-6">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background" aria-hidden="true">
                  {number + 1}
                </span>
                <span className="min-w-0">{step}</span>
              </li>
            ))}
          </ol>
          {stop.to ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0"
              onClick={() => {
                finish();
                navigate(stop.to!);
              }}
              data-testid="feature-tour-open"
            >
              Open {stop.title} <ChevronRight className="size-3.5" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
        <div className="px-6 pb-3">
          <ProgressBar label="Tour progress" value={(index + 1) / STOPS.length} valueText={`${index + 1} of ${STOPS.length}`} />
        </div>
        <div className="flex items-center gap-2 border-t border-border p-3">
          <Button type="button" variant="outline" size="lg" className="min-w-12" onClick={() => go(-1)} disabled={index === 0} aria-label="Previous">
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button type="button" size="lg" className="flex-1" onClick={() => (last ? finish() : go(1))} data-testid="feature-tour-next">
            {last ? "Done" : "Next"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
