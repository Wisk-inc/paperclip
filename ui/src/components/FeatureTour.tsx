import { useCallback, useEffect, useRef, useState } from "react";
import {
  Boxes,
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
  Users,
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Mascot, type MascotPose } from "@/components/mascot/Mascot";
import { haptic } from "@/lib/haptics";
import { FEATURE_TOUR_EVENT, featureTourPending, markFeatureTourDone } from "@/lib/feature-tour";
import { useNavigate } from "@/lib/router";
import { cn } from "@/lib/utils";

interface TourStop {
  icon: typeof House;
  title: string;
  what: string;
  why: string;
  to: string;
  pose: MascotPose;
}

/** Every section, in the order the app lays them out, in plain words. */
const STOPS: TourStop[] = [
  { icon: House, title: "Home", pose: "cheering", to: "/dashboard", what: "Your day at a glance: what needs you, who is working, and what it has cost this month.", why: "Open the app, read one screen, and know whether anything is waiting on you." },
  { icon: MessagesSquare, title: "Chats", pose: "excited", to: "/chats", what: "Talk to an agent like a teammate. Send text, photos and files, and switch the model from the header.", why: "The fastest way to hand off work: say it, and the agent turns it into tasks." },
  { icon: CircleCheck, title: "Tasks", pose: "thinking", to: "/issues", what: "Everything the agents are doing, each one a thread you can read, steer, and approve.", why: "Nothing happens silently. Every piece of work has a page, an owner, and a history." },
  { icon: Inbox, title: "Inbox and Approvals", pose: "excited", to: "/inbox", what: "Decisions waiting on you: hires, budgets, plans, and anything an agent got stuck on.", why: "Agents never spend or hire without a yes from you. This is where you say it." },
  { icon: Users, title: "Agents", pose: "cheering", to: "/agents", what: "Your team. Each agent has a role, a model, a system prompt, a budget, and a manager.", why: "Give a role once; the agent keeps to it on every task. Pause or change it anytime." },
  { icon: Repeat, title: "Projects and Routines", pose: "thinking", to: "/projects", what: "Projects group tasks under one goal. Routines run work on a schedule, like a daily summary.", why: "Set the goal, pick the rhythm, and the work keeps happening while you are away." },
  { icon: Boxes, title: "Skills and Connectors", pose: "excited", to: "/skills", what: "Skills are what agents know how to do. Connectors are the apps they can reach: GitHub, Slack, Gmail and more.", why: "Add a skill or a connector and every agent can use it from the next run." },
  { icon: CodeXml, title: "App Studio", pose: "cheering", to: "/studio", what: "Build, run and share apps from your phone with an AI pair that writes the code and fixes what breaks.", why: "Describe it, see it run, send a link. Your API key powers it; the files stay on your device." },
  { icon: FolderSync, title: "Files", pose: "thinking", to: "/device-files", what: "Share a folder on this phone with your agents, and get the files they make back here.", why: "Photos, documents, results: they move between you and the agents without a laptop." },
  { icon: History, title: "Audit", pose: "excited", to: "/activity", what: "Everything that happened: activity, runs, costs, budgets, and a timeline you can scroll.", why: "When you wonder why something happened, the answer is here, with who did it and when." },
  { icon: Plug, title: "Settings and API keys", pose: "cheering", to: "/company/settings/api-keys", what: "Your keys, members, budgets and colours. One API key page feeds agents, chats and App Studio.", why: "Add a key once; everything uses it. Remove it and everything stops. No surprises." },
];

/**
 * The feature tour: a card per section with what it is and why it matters, a
 * link straight into it, and a Skip at every step. Opens once after
 * onboarding and from "Take the tour" in the account sheet.
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
        className="gap-0 overflow-hidden p-0 sm:max-w-md"
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
        <div className="flex flex-col items-center gap-3 px-6 pt-2 pb-4 text-center" key={stop.title}>
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
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => {
              finish();
              navigate(stop.to);
            }}
            data-testid="feature-tour-open"
          >
            Open {stop.title} <ChevronRight className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
        <div className="flex items-center justify-center gap-1.5 pb-3" aria-hidden="true">
          {STOPS.map((item, dot) => (
            <span key={item.title} className={cn("h-1.5 rounded-full transition-all", dot === index ? "w-5 bg-foreground" : "w-1.5 bg-border")} />
          ))}
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
